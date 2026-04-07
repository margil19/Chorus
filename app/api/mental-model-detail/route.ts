import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

// ── Clients ───────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModelDetail {
  explanation: string
  when_to_use: string
  guest_takes: Array<{ guest: string; take: string }>
  tensions: string
}

// ── Module-level cache (max 200 entries, LRU-style) ───────────────────────────

const detailCache = new Map<string, ModelDetail>()
const MAX_CACHE = 200

function cacheSet(key: string, value: ModelDetail) {
  if (detailCache.size >= MAX_CACHE) {
    // Evict oldest entry
    const firstKey = detailCache.keys().next().value
    if (firstKey !== undefined) detailCache.delete(firstKey)
  }
  detailCache.set(key, value)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const DETAIL_PROMPT = (modelName: string, context: string) =>
  `You are explaining a mental model used by top product leaders.

Mental Model: "${modelName}"

Context — quotes from guests who referenced this model:
${context}

Return a JSON object with exactly these fields:
{
  "explanation": "Clear 2–3 sentence explanation of what this mental model is and how it works",
  "when_to_use": "1–2 sentences on when a product leader should apply this framework",
  "guest_takes": [
    { "guest": "Guest Name", "take": "Their specific angle or application of this model in 1–2 sentences" }
  ],
  "tensions": "1–2 sentences on when this model breaks down or conflicts with other approaches"
}

Be concrete and grounded in the quotes provided. The guest_takes array should have one entry per guest (max 4). Return only the JSON object, no markdown fences.`.trim()

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { model_name: rawModelName } = (await req.json()) as { model_name?: string }
    const model_name = rawModelName?.trim()

    if (!model_name) {
      return Response.json({ error: 'model_name is required' }, { status: 400 })
    }

    // Check cache first
    const cacheKey = model_name.toLowerCase()
    const cached = detailCache.get(cacheKey)
    if (cached) {
      return Response.json(cached)
    }

    // Fetch episodes that include this mental model
    const { data, error } = await supabase
      .from('episodes')
      .select('guest, title, key_quotes')
      .contains('mental_models', [model_name])
      .limit(8)

    if (error) {
      return Response.json({ error: error.message }, { status: 500 })
    }

    const episodes = (data ?? []) as {
      guest: string
      title: string
      key_quotes: string[] | null
    }[]

    if (episodes.length === 0) {
      return Response.json(
        { error: `No episodes found for model "${model_name}".` },
        { status: 404 }
      )
    }

    // Build context from key_quotes (first 2 per episode, max 4 episodes)
    const context = episodes
      .slice(0, 4)
      .map((ep) => {
        const quotes = (ep.key_quotes ?? []).slice(0, 2)
        if (quotes.length === 0) return `[${ep.guest} — "${ep.title.slice(0, 60)}"]`
        return `[${ep.guest} — "${ep.title.slice(0, 60)}"]\n${quotes.map((q) => `"${q}"`).join('\n')}`
      })
      .join('\n\n')

    // Call Claude Sonnet
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: DETAIL_PROMPT(model_name, context),
        },
      ],
    })

    const raw = message.content[0].type === 'text' ? message.content[0].text : ''
    const detail = JSON.parse(stripFences(raw)) as ModelDetail

    cacheSet(cacheKey, detail)

    return Response.json(detail)
  } catch (err) {
    console.error('/api/mental-model-detail error:', err)
    return Response.json(
      { error: (err as Error).message ?? 'Internal server error' },
      { status: 500 }
    )
  }
}
