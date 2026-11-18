import type { SupabaseClient } from '@supabase/supabase-js'

export interface RetrievedChunk {
  chunk_id: string
  episode_id: string
  guest: string
  title: string
  youtube_url: string | null
  video_id: string | null
  mental_models: string[]
  key_quotes: string[]
  guest_context: Record<string, string> | null
  speaker: string
  timestamp_start: string
  question: string | null
  segment_index: number
  window_index: number
  text: string
  similarity: number
  vector_rank: number | null
  text_rank: number | null
  rrf_score: number
  rerank_score?: number
}

const VOYAGE_URL = 'https://api.voyageai.com/v1'

export async function embedQuery(query: string): Promise<number[]> {
  const res = await fetch(`${VOYAGE_URL}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'voyage-3-large', input: [query], input_type: 'query' }),
  })
  if (!res.ok) throw new Error(`Voyage embeddings ${res.status}: ${await res.text()}`)
  return ((await res.json()) as { data: { embedding: number[] }[] }).data[0].embedding
}

/**
 * Candidates from match_chunks_v2. Pass `keywords` to merge in full-text matches (RRF);
 * null = vector only. In scripts/eval/compare-rerank.ts keyword candidates added no
 * relevance once results are reranked, on generic or named-entity questions, and cost latency.
 */
export async function searchChunks(
  supabase: SupabaseClient,
  embedding: number[],
  keywords: string | null,
  matchCount = 40
): Promise<RetrievedChunk[]> {
  const { data, error } = await supabase.rpc('match_chunks_v2', {
    query_embedding: embedding,
    query_text: keywords,
    match_count: matchCount,
  })
  if (error) throw new Error(`match_chunks_v2: ${error.message}`)
  return (data ?? []) as RetrievedChunk[]
}

/** Nearest chunks from one guest's episodes (exact scan; for debate). */
export async function searchGuestChunks(
  supabase: SupabaseClient,
  embedding: number[],
  guest: string,
  matchCount = 20
): Promise<RetrievedChunk[]> {
  const { data, error } = await supabase.rpc('match_guest_chunks_v2', {
    query_embedding: embedding,
    guest_name: guest,
    match_count: matchCount,
  })
  if (error) throw new Error(`match_guest_chunks_v2: ${error.message}`)
  return (data ?? []) as RetrievedChunk[]
}

const NEIGHBOR_CHARS = 600

/** Joins two consecutive windows, dropping the sentences they share (windows overlap ~200 chars). */
function joinWindows(a: string, b: string): string {
  for (let k = Math.min(a.length, b.length, 600); k >= 20; k--) {
    if (a.endsWith(b.slice(0, k))) return a + b.slice(k)
  }
  return `${a} ${b}`
}

export interface Passage { chunk: RetrievedChunk; text: string }

/**
 * Small-to-big: each retrieved window is widened with the tail of the previous and the
 * head of the next window from the same answer, so the model sees the argument around
 * the matched passage rather than a fragment.
 */
export async function expandToPassages(supabase: SupabaseClient, chunks: RetrievedChunk[]): Promise<Passage[]> {
  if (chunks.length === 0) return []
  const filter = chunks
    .map((c) => `and(episode_id.eq.${c.episode_id},segment_index.eq.${c.segment_index},window_index.gte.${c.window_index - 1},window_index.lte.${c.window_index + 1})`)
    .join(',')
  const { data, error } = await supabase
    .from('chunks_v2')
    .select('episode_id, segment_index, window_index, text')
    .or(filter)
  if (error) throw new Error(`expandToPassages: ${error.message}`)
  const byKey = new Map(
    (data as { episode_id: string; segment_index: number; window_index: number; text: string }[])
      .map((r) => [`${r.episode_id}:${r.segment_index}:${r.window_index}`, r.text])
  )
  return chunks.map((c) => {
    const prev = byKey.get(`${c.episode_id}:${c.segment_index}:${c.window_index - 1}`)
    const next = byKey.get(`${c.episode_id}:${c.segment_index}:${c.window_index + 1}`)
    let text = c.text
    if (prev) text = joinWindows(prev, text).slice(-(c.text.length + NEIGHBOR_CHARS)).replace(/^\S*\s/, '…')
    if (next) {
      const joined = joinWindows(text, next)
      text = joined.length > text.length + NEIGHBOR_CHARS ? joined.slice(0, text.length + NEIGHBOR_CHARS).replace(/\s\S*$/, '…') : joined
    }
    return { chunk: c, text }
  })
}

// Same context the chunk was embedded with: the host question only on an answer's first window.
function rerankDocument(c: RetrievedChunk): string {
  const q = c.question && c.window_index === 0 ? `Lenny asked: "${c.question}"\n` : ''
  return `${c.guest} — "${c.title}"\n${q}${c.text}`
}

export async function rerank(query: string, chunks: RetrievedChunk[], model = 'rerank-2.5'): Promise<RetrievedChunk[]> {
  if (chunks.length === 0) return chunks
  const res = await fetch(`${VOYAGE_URL}/rerank`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, query, documents: chunks.map(rerankDocument) }),
  })
  if (!res.ok) throw new Error(`Voyage rerank ${res.status}: ${await res.text()}`)
  const { data } = (await res.json()) as { data: { index: number; relevance_score: number }[] }
  return data.map((d) => ({ ...chunks[d.index], rerank_score: d.relevance_score }))
}

/** "Elena Verna 2.0" and "Shreyas Doshi Live" are the same person as the base name. */
export function personKey(guest: string): string {
  return guest.replace(/\s+(\d+\.\d+|live)$/i, '').trim().toLowerCase()
}

/** People among the candidates whose full name or surname appears in the question. */
export function peopleNamedIn(question: string, chunks: RetrievedChunk[]): Set<string> {
  const q = question.toLowerCase()
  const named = new Set<string>()
  for (const c of chunks) {
    const key = personKey(c.guest)
    const parts = key.split(/\s+/)
    const surname = parts[parts.length - 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (q.includes(key) || (parts.length > 1 && surname.length > 3 && new RegExp(`\\b${surname}\\b`).test(q))) named.add(key)
  }
  return named
}

/**
 * Walks chunks in ranked order keeping at most `maxPerGuest` per person (no cap for
 * people the question names) and one per answer segment (sibling windows overlap and
 * are re-attached later as context). If the cap leaves slots empty — a topic only one
 * guest really covers — they're backfilled in rank order, still one per segment.
 */
export function diversify(chunks: RetrievedChunk[], limit: number, maxPerGuest = 2, uncapped = new Set<string>()): RetrievedChunk[] {
  const perGuest = new Map<string, number>()
  const segments = new Set<string>()
  const picked = new Set<RetrievedChunk>()
  const take = (c: RetrievedChunk) => {
    perGuest.set(personKey(c.guest), (perGuest.get(personKey(c.guest)) ?? 0) + 1)
    segments.add(`${c.episode_id}:${c.segment_index}`)
    picked.add(c)
  }
  for (const c of chunks) {
    if (picked.size === limit) break
    const g = personKey(c.guest)
    if ((!uncapped.has(g) && (perGuest.get(g) ?? 0) >= maxPerGuest) || segments.has(`${c.episode_id}:${c.segment_index}`)) continue
    take(c)
  }
  for (const c of chunks) {
    if (picked.size === limit) break
    if (!picked.has(c) && !segments.has(`${c.episode_id}:${c.segment_index}`)) take(c)
  }
  return chunks.filter((c) => picked.has(c))
}

export interface RetrieveTimings { embed: number; search: number; rerank: number }

export async function retrieve(
  supabase: SupabaseClient,
  question: string,
  opts: { limit?: number; maxPerGuest?: number; candidates?: number; searchText?: string } = {}
): Promise<{ chunks: RetrievedChunk[]; candidates: RetrievedChunk[]; timings: RetrieveTimings }> {
  const t0 = Date.now()
  const embedding = await embedQuery(opts.searchText ?? question)
  const t1 = Date.now()
  const candidates = await searchChunks(supabase, embedding, null, opts.candidates ?? 40)
  const t2 = Date.now()
  const reranked = await rerank(question, candidates)
  const t3 = Date.now()
  return {
    chunks: diversify(reranked, opts.limit ?? 6, opts.maxPerGuest ?? 2, peopleNamedIn(question, candidates)),
    candidates,
    timings: { embed: t1 - t0, search: t2 - t1, rerank: t3 - t2 },
  }
}
