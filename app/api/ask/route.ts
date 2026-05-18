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
 * Static synthesis instructions — cached by Anthropic on repeated calls.
 * Keep this block stable; only the user message changes per request.
 */
const SYNTHESIS_SYSTEM = `\
You are Lenny's Brain — a synthesis engine built on 300+ conversations from Lenny's Podcast, \
the world's leading resource for product managers and growth leaders. \
Your job is to synthesize insights from podcast transcript excerpts into a structured, \
high-signal answer for product leaders. Be direct and specific. \
Attribute every insight to a named guest inline using **bold** (e.g. "**Ada Chen Rekhi** argues…").

Return ONLY valid JSON matching this exact schema — no markdown fences, no prose outside the object:

{
  "sections": [
    {
      "header": "4–6 word thematic header",
      "content": "2–3 sentences. Attribute at least one guest per section using **Name**. No padding."
    }
  ],
  "consensus": "1–2 sentences on what multiple guests clearly converge on, or null.",
  "contrarian": "The sharpest surprising take from a specific guest — name them — or null.",
  "bottom_line": "One crisp sentence. The single most actionable takeaway. Max 25 words.",
  "voices": [
    {
      "guest": "Exact guest name as it appears in the context",
      "summary": "2–3 sentences directly answering the question from this guest's specific perspective, using their ideas from the excerpt. Written as a proper answer, not a quote or transcript snippet.",
      "relevant": true
    }
  ]
}

Rules:
- Exactly 3–4 sections
- Every section names at least one guest in **bold**
- No walls of text — each section is 2–3 sentences max
- bottom_line must be ≤ 25 words and start with an imperative verb
- voices must have one entry per guest in the context, in order — maximum 4 entries
- Each voice summary directly answers the user's question from that specific guest's perspective only
- relevant: true if the guest's excerpt directly addresses the question; false if only tangentially \
related or requires significant inference. Be strict — mark false if the content required \
substantial guessing to connect to the question.`

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
      model: 'claude-haiku-3-5-20241022',
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

function sseResponse(
  fn: (enqueue: Enqueue) => Promise<void>
): Response {
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
      enqueue('sources', {
        sources: data.sources,
        guest_count: data.guest_count,
        rewritten_query: data.rewritten_query,
      })
      enqueue('done', data)
    })
  }

  const cacheKey = question.toLowerCase().trim()
  if (responseCache.has(cacheKey)) {
    const cached = responseCache.get(cacheKey)!
    return sseResponse(async (enqueue) => {
      enqueue('sources', {
        sources: cached.sources,
        guest_count: cached.guest_count,
        rewritten_query: cached.rewritten_query,
      })
      enqueue('done', cached)
    })
  }

  return sseResponse(async (enqueue) => {
    const t0 = Date.now()
    const lap = (label: string) => console.log(`[ask] ${label}: ${Date.now() - t0}ms`)

    // 1. Optionally rewrite query for better retrieval
    const queryToEmbed = skipRewrite ? question : await rewriteQuery(question)
    lap('rewrite')

    // 2. Embed the (possibly rewritten) query
    const embedding = await embedQuery(queryToEmbed)
    lap('embed')

    // 3. Hybrid search — reduced match_count for faster DB scan
    const { data: rawChunks, error: rpcError } = await supabase.rpc(
      'match_chunks',
      {
        query_embedding: embedding,
        query_text: queryToEmbed,
        match_count: 10,
      }
    )
    lap('supabase')

    if (rpcError) {
      console.error('Supabase RPC error:', rpcError)
      enqueue('error', {
        message:
          'Vector search failed. Make sure the updated match_chunks function is applied in Supabase.',
      })
      return
    }

    const chunks = (rawChunks ?? []) as ChunkMatch[]

    if (chunks.length === 0) {
      enqueue('error', {
        message: 'No relevant content found. Try a different question.',
      })
      return
    }

    // 4. Dedup to first unique chunk per guest, ordered by hybrid score
    const seen = new Set<string>()
    const topChunks: ChunkMatch[] = []
    for (const chunk of chunks) {
      if (!seen.has(chunk.guest)) {
        seen.add(chunk.guest)
        topChunks.push(chunk)
      }
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

    // 6. ⚡ Send sources immediately — client shows guest cards while Claude thinks
    enqueue('sources', {
      sources,
      guest_count: uniqueGuests,
      rewritten_query: queryToEmbed,
    })
    lap('sources_sent')

    // 7. Claude synthesis — system message is prompt-cached across requests
    const context = buildContext(topChunks)
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 900,
      system: [
        {
          type: 'text',
          text: SYNTHESIS_SYSTEM,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        { role: 'user', content: buildUserPrompt(queryToEmbed, context) },
      ],
    })

    lap('claude')
    const raw =
      message.content[0].type === 'text' ? message.content[0].text : ''

    const synthesis = JSON.parse(stripFences(raw)) as {
      sections: AnswerSection[]
      consensus: string | null
      contrarian: string | null
      bottom_line: string
      voices: Voice[]
    }

    const response: AskApiResponse = {
      sections: synthesis.sections,
      consensus: synthesis.consensus,
      contrarian: synthesis.contrarian,
      bottom_line: synthesis.bottom_line,
      sources,
      guest_count: uniqueGuests,
      rewritten_query: queryToEmbed,
      voices: (synthesis.voices ?? []).filter((v) => v.relevant !== false),
    }

    responseCache.set(cacheKey, response)
    if (responseCache.size > 100) {
      const firstKey = responseCache.keys().next().value
      responseCache.delete(firstKey!)
    }

    // 8. Send completed synthesis
    enqueue('done', response)
    lap('total')
  })
}
