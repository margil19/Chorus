import type { SupabaseClient } from '@supabase/supabase-js'
import type Anthropic from '@anthropic-ai/sdk'
import { retrieve, expandToPassages, personKey, type RetrievedChunk, type Passage } from './retrieval'

// ── Types (shared with app/ask/page.tsx) ──────────────────────────────────────

export interface GuestContext {
  industry?: string
  company_stage?: string
  guest_role?: string
  company?: string
  background?: string
}

export type Voice = { guest: string; summary: string; relevant: boolean }

export interface AnswerSection { header: string; content: string }

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

/** Events in the order they're emitted; /api/ask forwards each one as an SSE event. */
export type AnswerEvent =
  | { event: 'sources'; data: { sources: Source[]; guest_count: number; rewritten_query: string } }
  | { event: 'section'; data: AnswerSection }
  | { event: 'bottom_line'; data: { text: string } }
  | { event: 'voice'; data: Voice }
  | { event: 'meta'; data: { consensus: string | null; contrarian: string | null } }

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYNTHESIS_SYSTEM = `\
You are Chorus — a synthesis engine over Lenny's Podcast interviews with the world's best product, \
growth and leadership operators. You receive a question and numbered passages from guest interviews, \
and answer only from those passages.

Output newline-delimited JSON: one JSON object per line and nothing else — no code fences, no prose, \
no blank lines. In this order:

1. Three or four section lines:
{"type":"section","header":"4–6 word thematic header","content":"2–3 sentences answering the question. Put the guest's name in **bold** for every idea you attribute."}

2. One bottom line:
{"type":"bottom_line","text":"One imperative sentence, at most 25 words."}

3. One voice line per guest listed under GUESTS, in that order, with the name exactly as given:
{"type":"voice","guest":"<exact name>","summary":"2–3 sentences answering the question from this guest's passages only.","relevant":true}
Set "relevant" to false when that guest's passages don't actually address the question.

4. One meta line:
{"type":"meta","consensus":"1–2 sentences on where the guests converge, or null","contrarian":"The sharpest surprising or dissenting take, naming the guest, or null"}

Rules:
- Every claim must come from the passages. Never invent quotes, numbers, companies or positions.
- Prefer specific, actionable advice and named frameworks over generalities.
- Each section adds something new; don't restate the question or repeat another section.`

function buildUserPrompt(question: string, guests: string[], passages: Passage[]): string {
  const body = passages
    .map(({ chunk: c, text }, i) => {
      const q = c.question ? `Lenny asked: "${c.question}"\n` : ''
      return `[${i + 1}] ${c.guest} — "${c.title}"\n${q}${text}`
    })
    .join('\n\n')
  return `Question: "${question}"\n\nGUESTS: ${guests.join('; ')}\n\nPASSAGES:\n${body}`
}

// ── NDJSON stream parser ──────────────────────────────────────────────────────
// Brace-counts complete objects and ignores everything outside them, so a ```json
// fence or stray prose around the output can't swallow the next object.

export function makeNdjsonParser(onObject: (obj: Record<string, unknown>) => void) {
  let buffer = ''
  let depth = 0
  let inString = false
  let escaped = false

  return function push(chunk: string) {
    for (const ch of chunk) {
      if (depth === 0 && ch !== '{') continue
      buffer += ch
      if (escaped) { escaped = false; continue }
      if (ch === '\\' && inString) { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try { onObject(JSON.parse(buffer) as Record<string, unknown>) } catch { /* skip malformed */ }
          buffer = ''
        }
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timestampToSeconds(ts: string): number {
  if (!ts) return 0
  const parts = ts.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}

export function buildYouTubeUrl(videoId: string | null, timestamp: string): string {
  if (!videoId) return ''
  const t = timestampToSeconds(timestamp)
  const base = `https://www.youtube.com/watch?v=${videoId}`
  return t > 0 ? `${base}&t=${t}` : base
}

function toSource(c: RetrievedChunk): Source {
  return {
    guest: c.guest,
    quote: c.text.slice(0, 240) + (c.text.length > 240 ? '…' : ''),
    youtube_url: buildYouTubeUrl(c.video_id, c.timestamp_start),
    timestamp_start: c.timestamp_start,
    episode_title: c.title,
    mental_models: c.mental_models ?? [],
    key_quotes: c.key_quotes ?? [],
    guest_context: c.guest_context ?? null,
    video_id: c.video_id ?? '',
  }
}

const MAX_GUESTS = 4
const CONTEXT_CHUNKS = 6

// ── Pipeline ──────────────────────────────────────────────────────────────────

/**
 * Retrieve → widen to passages → stream Claude's synthesis. `emit` receives each piece
 * as soon as it's complete; the assembled response is returned at the end.
 */
export async function answerQuestion(
  supabase: SupabaseClient,
  anthropic: Anthropic,
  question: string,
  emit: (e: AnswerEvent) => void = () => {},
  log: (label: string) => void = () => {}
): Promise<AskApiResponse | null> {
  const { chunks, candidates } = await retrieve(supabase, question, { limit: CONTEXT_CHUNKS })
  log('retrieve')
  if (chunks.length === 0) return null

  // Voice cards: the first MAX_GUESTS people in rank order; context keeps only their chunks.
  const people: string[] = []
  const sourceByPerson = new Map<string, Source>()
  for (const c of chunks) {
    const key = personKey(c.guest)
    if (!sourceByPerson.has(key) && people.length < MAX_GUESTS) {
      people.push(key)
      sourceByPerson.set(key, toSource(c))
    }
  }
  const sources = [...sourceByPerson.values()]
  const contextChunks = chunks.filter((c) => sourceByPerson.has(personKey(c.guest)))
  const guestCount = new Set(candidates.map((c) => personKey(c.guest))).size

  emit({ event: 'sources', data: { sources, guest_count: guestCount, rewritten_query: question } })

  const passages = await expandToPassages(supabase, contextChunks)
  log('passages')

  const sections: AnswerSection[] = []
  let bottomLine = ''
  const voices: Voice[] = []
  let meta: { consensus: string | null; contrarian: string | null } = { consensus: null, contrarian: null }

  const parser = makeNdjsonParser((obj) => {
    if (obj.type === 'section' && typeof obj.header === 'string' && typeof obj.content === 'string') {
      const s = { header: obj.header, content: obj.content }
      sections.push(s)
      emit({ event: 'section', data: s })
    } else if (obj.type === 'bottom_line' && typeof obj.text === 'string') {
      bottomLine = obj.text
      emit({ event: 'bottom_line', data: { text: bottomLine } })
    } else if (obj.type === 'voice' && typeof obj.guest === 'string') {
      // Pin the voice to the source card's exact guest name so the UI can match them.
      const source = sourceByPerson.get(personKey(obj.guest))
      if (!source || voices.some((v) => v.guest === source.guest)) return
      const v: Voice = { guest: source.guest, summary: String(obj.summary ?? ''), relevant: obj.relevant !== false }
      voices.push(v)
      emit({ event: 'voice', data: v })
    } else if (obj.type === 'meta') {
      meta = { consensus: (obj.consensus as string | null) ?? null, contrarian: (obj.contrarian as string | null) ?? null }
      emit({ event: 'meta', data: meta })
    }
  })

  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-4-5',
    max_tokens: 1500,
    system: [{ type: 'text', text: SYNTHESIS_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserPrompt(question, sources.map((s) => s.guest), passages) }],
  })
  stream.on('text', (text) => parser(text))
  await stream.finalMessage()
  log('claude')

  return {
    sections,
    bottom_line: bottomLine,
    consensus: meta.consensus,
    contrarian: meta.contrarian,
    voices: voices.filter((v) => v.relevant),
    sources,
    guest_count: guestCount,
    rewritten_query: question,
  }
}

/** Replays a stored answer through the same events a live answer emits. */
export function replayAnswer(a: AskApiResponse, emit: (e: AnswerEvent) => void) {
  emit({ event: 'sources', data: { sources: a.sources, guest_count: a.guest_count, rewritten_query: a.rewritten_query } })
  for (const s of a.sections) emit({ event: 'section', data: s })
  if (a.bottom_line) emit({ event: 'bottom_line', data: { text: a.bottom_line } })
  for (const v of a.voices) emit({ event: 'voice', data: v })
  emit({ event: 'meta', data: { consensus: a.consensus, contrarian: a.contrarian } })
}
