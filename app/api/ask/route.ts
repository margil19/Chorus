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

/**
 * Rewrite the raw user question into a richer, more retrieval-friendly query.
 * Falls back to the original on any error so the pipeline never blocks.
 */
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

const SYNTHESIS_PROMPT = (question: string, context: string) => `
You are Lenny's Brain — a synthesis engine built on 300+ conversations from Lenny's Podcast, the world's leading resource for product managers and growth leaders.

A product leader has asked: "${question}"

Below are the most relevant insights from past guest interviews:

${context}

Write a structured, high-signal answer. Be direct and specific. Attribute every insight to a named guest inline using **bold** (e.g. "**Ada Chen Rekhi** argues…").

Return ONLY this exact JSON (no markdown fences, no prose outside JSON):
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
      "guest": "Exact guest name as it appears in the context above",
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
- voices must have one entry per guest in the context, in the order they appear
- Each voice summary directly answers the user's question from that specific guest's perspective only
- For each voice, set relevant: true if the guest's excerpt directly addresses the question; set relevant: false if the excerpt is only tangentially related or does not meaningfully answer the question. Be strict — if the guest's content required significant inference or doesn't speak to the question, mark it false.
`.trim()

// ── In-memory response cache (LRU, max 100 entries) ──────────────────────────

const responseCache = new Map<string, AskApiResponse>()

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { question: rawQuestion, skipRewrite } = (await req.json()) as {
      question?: string
      skipRewrite?: boolean
    }
    const question = rawQuestion?.trim()

    if (!question) {
      return Response.json({ error: 'question is required' }, { status: 400 })
    }

    // Check precomputed answers first — instant, no API calls
    const normalized = question.trim()
    const precomputed = (precomputedAnswers as Record<string, unknown>)[normalized]
    if (precomputed) {
      return Response.json(precomputed)
    }

    const cacheKey = question.toLowerCase().trim()
    if (responseCache.has(cacheKey)) {
      return Response.json(responseCache.get(cacheKey))
    }

    // 1. Optionally rewrite query for better retrieval
    const queryToEmbed = skipRewrite ? question : await rewriteQuery(question)

    // 2. Embed the (possibly rewritten) query
    const embedding = await embedQuery(queryToEmbed)

    // 3. Hybrid search (vector + full-text) via Supabase RPC
    const { data: rawChunks, error: rpcError } = await supabase.rpc(
      'match_chunks',
      {
        query_embedding: embedding,
        query_text: queryToEmbed,
        match_count: 60,
      }
    )

    if (rpcError) {
      console.error('Supabase RPC error:', rpcError)
      return Response.json(
        {
          error:
            'Vector search failed. Make sure the updated match_chunks function is applied in Supabase.',
        },
        { status: 500 }
      )
    }

    const chunks = (rawChunks ?? []) as ChunkMatch[]

    if (chunks.length === 0) {
      return Response.json(
        { error: 'No relevant content found. Try a different question.' },
        { status: 404 }
      )
    }

    // 4. Dedup to first unique chunk per guest, ordered by hybrid score
    const seen = new Set<string>()
    const topChunks: ChunkMatch[] = []
    for (const chunk of chunks) {
      if (!seen.has(chunk.guest)) {
        seen.add(chunk.guest)
        topChunks.push(chunk)
      }
      if (topChunks.length === 8) break
    }

    // 5. Build context for Claude from deduped chunks only
    const context = buildContext(topChunks)

    // 6. Claude synthesis
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: SYNTHESIS_PROMPT(queryToEmbed, context) }],
    })

    const raw =
      message.content[0].type === 'text' ? message.content[0].text : ''

    const synthesis = JSON.parse(stripFences(raw)) as {
      sections: AnswerSection[]
      consensus: string | null
      contrarian: string | null
      bottom_line: string
      voices: Voice[]
    }

    // 7. Build sources from the same deduped chunks
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

    const response: AskApiResponse = {
      sections: synthesis.sections,
      consensus: synthesis.consensus,
      contrarian: synthesis.contrarian,
      bottom_line: synthesis.bottom_line,
      sources,
      guest_count: uniqueGuests,
      rewritten_query: queryToEmbed,
      voices: (synthesis.voices ?? []).filter(v => v.relevant !== false),
    }

    responseCache.set(cacheKey, response)
    if (responseCache.size > 100) {
      const firstKey = responseCache.keys().next().value
      responseCache.delete(firstKey!)
    }

    return Response.json(response)
  } catch (err) {
    console.error('/api/ask error:', err)
    return Response.json(
      { error: (err as Error).message ?? 'Internal server error' },
      { status: 500 }
    )
  }
}
