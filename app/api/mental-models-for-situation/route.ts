import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ── Client ────────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Theme keywords ───────────────────────────────────────────────────────────

const THEME_KEYWORDS: Record<string, string[]> = {
  Prioritization: [
    'prioriti', 'roadmap', 'backlog', 'say no',
    'focus', 'tradeoff', 'ruthless', 'sequencing',
  ],
  Growth: [
    'growth', 'acquisition', 'retention', 'PLG',
    'viral', 'referral', 'activation', 'funnel',
    'north star', 'metric',
  ],
  Hiring: [
    'hiring', 'recruit', 'team', 'culture',
    'interview', 'onboard', 'performance',
    'manager', 'org design',
  ],
  Strategy: [
    'strategy', 'vision', 'positioning', 'moat',
    'competitive', 'market', 'pricing', 'platform',
  ],
  Leadership: [
    'leadership', 'influence', 'stakeholder',
    'communication', 'trust', 'feedback',
    'alignment', 'executive',
  ],
  '0→1': [
    'PMF', 'product-market fit', 'MVP', 'early',
    'founder', 'launch', 'validate', 'zero to one',
    'startup', 'discovery',
  ],
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface SituationGuest {
  guest: string
  title: string
  youtube_url: string
  guest_context: Record<string, string> | null
}

interface SituationModel {
  name: string
  count: number
  guests: SituationGuest[]
}

export interface SituationApiResponse {
  models: SituationModel[]
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { situation } = (await req.json()) as { situation?: string }
    const sit = situation?.trim()

    if (!sit) {
      return Response.json({ error: 'situation is required' }, { status: 400 })
    }

    // Determine keywords: if it matches a theme chip, use those keywords
    // Otherwise, split free text into words > 3 chars
    const themeKeywords = THEME_KEYWORDS[sit]
    const keywords: string[] = themeKeywords
      ? themeKeywords
      : sit
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3)

    if (keywords.length === 0) {
      return Response.json({ models: [] } satisfies SituationApiResponse)
    }

    // Fetch all episodes with mental models
    const { data, error } = await supabase
      .from('episodes')
      .select('guest, title, youtube_url, mental_models, guest_context')
      .not('mental_models', 'is', null)
      .filter('mental_models', 'not.eq', '{}')

    if (error) {
      return Response.json({ error: error.message }, { status: 500 })
    }

    const episodes = (data ?? []) as {
      guest: string
      title: string
      youtube_url: string
      mental_models: string[]
      guest_context: Record<string, string> | null
    }[]

    // Build model map (same structure as /api/mental-models)
    const modelMap = new Map<string, SituationGuest[]>()

    for (const ep of episodes) {
      if (!ep.mental_models || ep.mental_models.length === 0) continue
      for (const raw of ep.mental_models) {
        const name = raw.trim()
        if (!name) continue
        const entry: SituationGuest = {
          guest: ep.guest,
          title: ep.title,
          youtube_url: ep.youtube_url ?? '',
          guest_context: ep.guest_context ?? null,
        }
        const existing = modelMap.get(name)
        if (existing) {
          existing.push(entry)
        } else {
          modelMap.set(name, [entry])
        }
      }
    }

    // Filter models whose name contains any keyword (case-insensitive)
    const allModels: SituationModel[] = Array.from(modelMap.entries()).map(
      ([name, guests]) => ({ name, count: guests.length, guests })
    )

    const matchedNames = new Set<string>()
    const matched: SituationModel[] = []

    for (const model of allModels) {
      const nameLower = model.name.toLowerCase()
      for (const kw of keywords) {
        if (nameLower.includes(kw.toLowerCase())) {
          matched.push(model)
          matchedNames.add(model.name)
          break
        }
      }
    }

    // Sort by guest count descending
    matched.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

    // Take top 20
    let results = matched.slice(0, 20)

    // If fewer than 5 matches, supplement with most-referenced overall to reach 10
    if (results.length < 5) {
      const allSorted = allModels
        .filter((m) => !matchedNames.has(m.name))
        .sort((a, b) => b.count - a.count)

      const needed = 10 - results.length
      results = [...results, ...allSorted.slice(0, needed)]
    }

    return Response.json({ models: results } satisfies SituationApiResponse)
  } catch (err) {
    console.error('/api/mental-models-for-situation error:', err)
    return Response.json(
      { error: (err as Error).message ?? 'Internal server error' },
      { status: 500 }
    )
  }
}
