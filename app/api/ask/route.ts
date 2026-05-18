import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import precomputedAnswers from '@/lib/precomputed-answers.json'

// ── Clients ──────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChunkMatch {
  chunk_id: string
  episode_id: string
  speaker: string
  is_guest: boolean
  timestamp_start: string
  text: string
  similarity: number
  guest: string
  title: string
  youtube_url: string
  video_id: string
  mental_models: string[] | null
  key_quotes: string[] | null
  guest_context: GuestContext | null
}

export interface GuestContext {
  industry?: string
  company_stage?: string
  guest_role?: string
  company?: string
  background?: string
}

export type Voice = {
  guest: string
  summary: string
  relevant: boolean
}

export interface AnswerSection {
  header: string
  content: string
}

export interface Source {
  guest: string
  quote: string
  youtube_url: string
  timestamp_start: string
  episode_title: string
  mental_models: string[]
  key_quotes: string[]
  guest_context: GuestContext | null
  video_id: string
}

export interface AskApiResponse {
  sections: AnswerSection[]
  consensus: string | null
  contrarian: string | null
  bottom_line: string
  sources: Source[]
  guest_count: number
  rewritten_query: string
  voices: Voice[]
}

// ── Prompts ───────────────────────────────────────────────────────────────────

/**
 * Claude outputs NDJSON — one JSON object per line, in this order:
 *   1. synthesis object  (sections + bottom_line)
 *   2. voice objects     (one per guest, max 4)
 *   3. meta object       (consensus + contrarian)
 *
 * This lets us emit each piece as an SSE event the moment it completes,
 * so the UI renders progressively instead of waiting for the full response.
 */
const SYNTHESIS_SYSTEM = `\
You are Lenny's Brain — a synthesis engine built on 300+ conversations from Lenny's Podcast, \
the world's leading resource for product managers and growth leaders.

Output your response as newline-delimited JSON (NDJSON). \
Each JSON object must be on a single line with no line breaks inside it. \
Output exactly in this order with nothing else:

Line 1 — synthesis:
{"type":"synthesis","sections":[{"header":"4–6 word thematic header","content":"2–3 sentences. Use **Guest Name** attribution for at least one guest per section."}],"bottom_line":"One imperative sentence ≤25 words."}

Lines 2–N — one voice per guest in context order (max 4):
{"type":"voice","guest":"Exact guest name","summary":"2–3 sentences directly answering the question from this guest's perspective only.","relevant":true}

Final line — meta:
{"type":"meta","consensus":"1–2 sentences on what guests converge on, or null","contrarian":"Sharpest surprising take naming the guest, or null"}

Rules:
- Exactly 3–4 sections in the synthesis object
- Every section attributes at least one guest in **bold**
- 2–3 sentences max per section, no padding
- bottom_line starts with an imperative verb, ≤25 words
- One voice entry per guest in context, max 4 total
- relevant: true if the excerpt directly addresses the question; false if only tangential
- No markdown fences, no text outside the JSON objects, no blank lines between objects`

function buildUserPrompt(question: string, context: string): string {
  return `A product leader has asked: "${question}"

Below are the most relevant insights from past guest interviews:

${context}

Write a high-signal answer using only these excerpts.`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timestampToSeconds(ts: string): number {
  if (!ts) return 0
  const parts = ts.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}

function buildYouTubeUrl(videoId: string, timestamp: string): string {
  const t = timestampToSeconds(timestamp)
  const base = `https://www.youtube.com/watch?v=${videoId}`
  return t > 0 ? `${base}&t=${t}` : base
}

function buildContext(chunks: ChunkMatch[]): string {
  return chunks
    .map(
      (c) =>
        `[${c.guest} — "${c.title.slice(0, 70)}${c.title.length > 70 ? '…' : ''}"]\n"${c.text.slice(0, 400)}${c.text.length > 400 ? '…' : ''}"`
    )
    .join('\n\n')
}

function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
}

// ── Claude calls ──────────────────────────────────────────────────────────────

async function rewriteQuery(question: string): Promise<string> {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 120,
      messages: [
        {
          role: 'user',
          content:
            'Rewrite this question to be more specific and searchable for retrieval from podcast transcripts about product management, growth, and leadership. Return only the rewritten query, nothing else.\n\nQuestion: ' +
            question,
        },
      ],
    })
    const text =
      msg.content[0].type === 'text' ? msg.content[0].text.trim() : ''
    return text || question
  } catch {
    return question
  }
}

async function embedQuery(query: string): Promise<number[]> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'voyage-3-large', input: [query] }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Voyage API error ${res.status}: ${body}`)
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] }
  return data.data[0].embedding
}

// ── SSE helper ────────────────────────────────────────────────────────────────

type Enqueue = (event: string, data: unknown) => void

function sseResponse(fn: (enqueue: Enqueue) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue: Enqueue = (event, data) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        )
      }
      try {
        await fn(enqueue)
      } catch (err) {
        enqueue('error', { message: (err as Error).message ?? 'Internal server error' })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

// ── NDJSON stream parser ──────────────────────────────────────────────────────
// Counts braces to detect complete JSON objects without relying on newlines.

function makeNdjsonParser(onObject: (obj: Record<string, unknown>) => void) {
  let buffer = ''
  let depth = 0
  let inString = false
  let escaped = false

  return function push(chunk: string) {
    for (const ch of chunk) {
      buffer += ch
      if (escaped) { escaped = false; continue }
      if (ch === '\\' && inString) { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0 && buffer.trim()) {
          try { onObject(JSON.parse(buffer.trim()) as Record<string, unknown>) } catch { /* skip malformed */ }
          buffer = ''
        }
      }
    }
  }
}

// ── In-memory response cache (LRU, max 100 entries) ──────────────────────────

const responseCache = new Map<string, AskApiResponse>()

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { question: rawQuestion, skipRewrite } = (await req.json()) as {
    question?: string
    skipRewrite?: boolean
  }
  const question = rawQuestion?.trim()

  if (!question) {
    return Response.json({ error: 'question is required' }, { status: 400 })
  }

  // Check precomputed answers — instant, no API calls
  const precomputed = (precomputedAnswers as Record<string, unknown>)[question]
  if (precomputed) {
    const data = precomputed as AskApiResponse
    return sseResponse(async (enqueue) => {
      enqueue('sources', { sources: data.sources, guest_count: data.guest_count, rewritten_query: data.rewritten_query })
      enqueue('synthesis', { sections: data.sections, bottom_line: data.bottom_line })
      for (const v of data.voices) enqueue('voice', v)
      enqueue('meta', { consensus: data.consensus, contrarian: data.contrarian })
      enqueue('done', data)
    })
  }

  const cacheKey = question.toLowerCase().trim()
  if (responseCache.has(cacheKey)) {
    const cached = responseCache.get(cacheKey)!
    return sseResponse(async (enqueue) => {
      enqueue('sources', { sources: cached.sources, guest_count: cached.guest_count, rewritten_query: cached.rewritten_query })
      enqueue('synthesis', { sections: cached.sections, bottom_line: cached.bottom_line })
      for (const v of cached.voices) enqueue('voice', v)
      enqueue('meta', { consensus: cached.consensus, contrarian: cached.contrarian })
      enqueue('done', cached)
    })
  }

  return sseResponse(async (enqueue) => {
    const t0 = Date.now()
    const lap = (label: string) => console.log(`[ask] ${label}: ${Date.now() - t0}ms`)

    // 1. Optionally rewrite query
    const queryToEmbed = skipRewrite ? question : await rewriteQuery(question)
    lap('rewrite')

    // 2. Embed
    const embedding = await embedQuery(queryToEmbed)
    lap('embed')

    // 3. Hybrid search
    const { data: rawChunks, error: rpcError } = await supabase.rpc('match_chunks', {
      query_embedding: embedding,
      query_text: queryToEmbed,
      match_count: 10,
    })
    lap('supabase')

    if (rpcError) {
      console.error('Supabase RPC error:', rpcError)
      enqueue('error', { message: 'Vector search failed. Make sure the updated match_chunks function is applied in Supabase.' })
      return
    }

    const chunks = (rawChunks ?? []) as ChunkMatch[]
    if (chunks.length === 0) {
      enqueue('error', { message: 'No relevant content found. Try a different question.' })
      return
    }

    // 4. Dedup — top 4 unique guests
    const seen = new Set<string>()
    const topChunks: ChunkMatch[] = []
    for (const chunk of chunks) {
      if (!seen.has(chunk.guest)) { seen.add(chunk.guest); topChunks.push(chunk) }
      if (topChunks.length === 4) break
    }

    // 5. Build sources
    const sources: Source[] = topChunks.map((c) => ({
      guest: c.guest,
      quote: c.text.slice(0, 240) + (c.text.length > 240 ? '…' : ''),
      youtube_url: buildYouTubeUrl(c.video_id, c.timestamp_start),
      timestamp_start: c.timestamp_start,
      episode_title: c.title,
      mental_models: c.mental_models ?? [],
      key_quotes: c.key_quotes ?? [],
      guest_context: c.guest_context ?? null,
      video_id: c.video_id,
    }))

    const uniqueGuests = new Set(chunks.map((c) => c.guest)).size

    // 6. ⚡ Send sources immediately
    enqueue('sources', { sources, guest_count: uniqueGuests, rewritten_query: queryToEmbed })
    lap('sources_sent')

    // 7. Stream Claude synthesis — emit each NDJSON object as it completes
    const context = buildContext(topChunks)

    // Accumulate parts for final cache entry
    let synthesisPart: { sections: AnswerSection[]; bottom_line: string } | null = null
    const voiceParts: Voice[] = []
    let metaPart: { consensus: string | null; contrarian: string | null } | null = null

    const parser = makeNdjsonParser((obj) => {
      if (obj.type === 'synthesis') {
        synthesisPart = obj as unknown as typeof synthesisPart
        enqueue('synthesis', obj)
      } else if (obj.type === 'voice') {
        voiceParts.push(obj as unknown as Voice)
        enqueue('voice', obj)
      } else if (obj.type === 'meta') {
        metaPart = obj as unknown as typeof metaPart
        enqueue('meta', obj)
      }
    })

    const claudeStream = anthropic.messages.stream({
      model: 'claude-sonnet-4-5',
      max_tokens: 900,
      system: [{ type: 'text', text: SYNTHESIS_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildUserPrompt(queryToEmbed, context) }],
    })

    claudeStream.on('text', (text) => parser(text))
    await claudeStream.finalMessage()
    lap('claude')

    // 8. Assemble full response for cache
    const response: AskApiResponse = {
      sections: synthesisPart ? (synthesisPart as { sections: AnswerSection[] }).sections : [],
      bottom_line: synthesisPart ? (synthesisPart as { bottom_line: string }).bottom_line : '',
      consensus: metaPart ? (metaPart as { consensus: string | null }).consensus : null,
      contrarian: metaPart ? (metaPart as { contrarian: string | null }).contrarian : null,
      voices: voiceParts.filter((v) => v.relevant !== false),
      sources,
      guest_count: uniqueGuests,
      rewritten_query: queryToEmbed,
    }

    responseCache.set(cacheKey, response)
    if (responseCache.size > 100) {
      const firstKey = responseCache.keys().next().value
      responseCache.delete(firstKey!)
    }

    enqueue('done', response)
    lap('total')
  })
}
