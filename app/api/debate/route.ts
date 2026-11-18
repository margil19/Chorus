import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { embedQuery, searchGuestChunks, rerank, type RetrievedChunk } from '@/lib/retrieval'
import { buildYouTubeUrl } from '@/lib/answer'

// ── Clients ───────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface DebateSource {
  youtube_url: string
  title: string
}

export interface DebateApiResponse {
  question: string
  guest1: string
  guest2: string
  agreement: string
  guest1_position: string
  guest2_position: string
  core_disagreement: string
  bottom_line: string
  guest1_relevant: boolean
  guest2_relevant: boolean
  guest1_source: DebateSource | null
  guest2_source: DebateSource | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
}

function buildGuestContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c) => {
      const asked = c.question ? `Lenny asked: "${c.question}"\n` : ''
      return `[${c.guest} — "${c.title.slice(0, 70)}${c.title.length > 70 ? '…' : ''}"]\n${asked}"${c.text}"`
    })
    .join('\n\n')
}

/** A guest's passages most relevant to the question: nearest 20 of theirs, reranked to 5. */
async function guestPassages(embedding: number[], question: string, guest: string): Promise<RetrievedChunk[]> {
  const nearest = await searchGuestChunks(supabase, embedding, guest, 20)
  return (await rerank(question, nearest)).slice(0, 5)
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const DEBATE_PROMPT = (
  question: string,
  guest1: string,
  guest1Context: string,
  guest2: string,
  guest2Context: string
) =>
  `You are analyzing a debate between two product experts based on their actual podcast statements.

Guest 1: ${guest1}
Guest 1 context:
${guest1Context}

Guest 2: ${guest2}
Guest 2 context:
${guest2Context}

Question: ${question}

Return a JSON object with exactly these fields:
{
  "agreement": "Where both guests fundamentally agree — 2-3 sentences",
  "guest1_position": "${guest1}'s specific position on this question — 3-4 sentences grounded in their actual statements",
  "guest2_position": "${guest2}'s specific position on this question — 3-4 sentences grounded in their actual statements",
  "core_disagreement": "The sharpest point where they diverge — be specific, not generic",
  "bottom_line": "Whose view is more defensible and why — take a stance, 2 sentences max",
  "guest1_relevant": true or false — whether ${guest1}'s excerpts actually address the question,
  "guest2_relevant": true or false — whether ${guest2}'s excerpts actually address the question
}

Be specific and grounded in what they actually said. Do not hallucinate positions. Return only the JSON object, no markdown fences.`.trim()

// ── GET: shared topics between two guests ────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const guest1 = url.searchParams.get('guest1')?.trim()
    const guest2 = url.searchParams.get('guest2')?.trim()

    if (!guest1 || !guest2) {
      return Response.json({ error: 'guest1 and guest2 are required' }, { status: 400 })
    }
    if (guest1 === guest2) {
      return Response.json({ error: 'Guests must be different' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('episodes')
      .select('guest, mental_models')
      .in('guest', [guest1, guest2])
      .not('mental_models', 'is', null)

    if (error) {
      return Response.json({ error: error.message }, { status: 500 })
    }

    // Build per-guest model maps: lowercase key → original casing
    const models1 = new Map<string, string>()
    const models2 = new Map<string, string>()
    const combined = new Map<string, number>()

    for (const ep of (data ?? []) as { guest: string; mental_models: string[] | null }[]) {
      const models = ep.mental_models ?? []
      for (const raw of models) {
        const name = raw.trim()
        if (!name) continue
        const key = name.toLowerCase()
        combined.set(key, (combined.get(key) ?? 0) + 1)
        if (ep.guest === guest1 && !models1.has(key)) models1.set(key, name)
        else if (ep.guest === guest2 && !models2.has(key)) models2.set(key, name)
      }
    }

    // Intersection: models that appear in both guests' episodes
    const shared = [...models1.keys()].filter((k) => models2.has(k)).sort()

    let topics: string[]
    if (shared.length >= 4) {
      topics = shared.slice(0, 6).map((k) => models1.get(k) ?? k)
    } else {
      // Supplement with most common models from either guest
      const candidates = [...combined.entries()]
        .filter(([k]) => models1.has(k) || models2.has(k))
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => k)

      const selected = new Set<string>(shared)
      for (const k of candidates) {
        if (selected.size >= 6) break
        selected.add(k)
      }
      topics = [...selected].sort().map((k) => models1.get(k) ?? models2.get(k) ?? k)
    }

    return Response.json({ topics, guest1, guest2 })
  } catch (err) {
    return Response.json(
      { error: (err as Error).message ?? 'Internal server error' },
      { status: 500 }
    )
  }
}

// ── POST: run debate ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const {
      question: rawQuestion,
      guest1: rawGuest1,
      guest2: rawGuest2,
    } = (await req.json()) as {
      question?: string
      guest1?: string
      guest2?: string
    }

    const question = rawQuestion?.trim()
    const guest1 = rawGuest1?.trim()
    const guest2 = rawGuest2?.trim()

    if (!question) return Response.json({ error: 'question is required' }, { status: 400 })
    if (!guest1) return Response.json({ error: 'guest1 is required' }, { status: 400 })
    if (!guest2) return Response.json({ error: 'guest2 is required' }, { status: 400 })
    if (guest1 === guest2) return Response.json({ error: 'Guests must be different' }, { status: 400 })

    // Embed once — both guests share the same question embedding
    const embedding = await embedQuery(question)

    const [chunks1, chunks2] = await Promise.all([
      guestPassages(embedding, question, guest1),
      guestPassages(embedding, question, guest2),
    ])

    if (chunks1.length === 0) {
      return Response.json(
        { error: `No content found for ${guest1}. They may not be in this dataset.` },
        { status: 404 }
      )
    }
    if (chunks2.length === 0) {
      return Response.json(
        { error: `No content found for ${guest2}. They may not be in this dataset.` },
        { status: 404 }
      )
    }

    const guest1Context = buildGuestContext(chunks1)
    const guest2Context = buildGuestContext(chunks2)

    // Claude synthesis
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [
        {
          role: 'user',
          content: DEBATE_PROMPT(question, guest1, guest1Context, guest2, guest2Context),
        },
      ],
    })

    const raw = message.content[0].type === 'text' ? message.content[0].text : ''

    const synthesis = JSON.parse(stripFences(raw)) as {
      agreement: string
      guest1_position: string
      guest2_position: string
      core_disagreement: string
      bottom_line: string
      guest1_relevant: boolean
      guest2_relevant: boolean
    }

    const response: DebateApiResponse = {
      question,
      guest1,
      guest2,
      agreement: synthesis.agreement,
      guest1_position: synthesis.guest1_position,
      guest2_position: synthesis.guest2_position,
      core_disagreement: synthesis.core_disagreement,
      bottom_line: synthesis.bottom_line,
      guest1_relevant: synthesis.guest1_relevant,
      guest2_relevant: synthesis.guest2_relevant,
      guest1_source: {
        youtube_url: buildYouTubeUrl(chunks1[0].video_id, chunks1[0].timestamp_start),
        title: chunks1[0].title,
      },
      guest2_source: {
        youtube_url: buildYouTubeUrl(chunks2[0].video_id, chunks2[0].timestamp_start),
        title: chunks2[0].title,
      },
    }

    return Response.json(response)
  } catch (err) {
    console.error('/api/debate error:', err)
    return Response.json(
      { error: (err as Error).message ?? 'Internal server error' },
      { status: 500 }
    )
  }
}
