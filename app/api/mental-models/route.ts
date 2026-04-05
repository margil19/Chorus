import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ── Client ────────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MentalModelGuest {
  guest: string
  title: string
  youtube_url: string
  guest_context: Record<string, string> | null
}

export interface MentalModel {
  name: string
  count: number
  guests: MentalModelGuest[]
}

export interface MentalModelsApiResponse {
  models: MentalModel[]
  total_models: number
  total_episodes: number
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest) {
  try {
    const { data, error } = await supabase
      .from('episodes')
      .select('guest, title, youtube_url, mental_models, guest_context')
      .not('mental_models', 'is', null)
      .filter('mental_models', 'not.eq', '{}')

    if (error) {
      console.error('Supabase error:', error)
      return Response.json({ error: 'Failed to load mental models.' }, { status: 500 })
    }

    const episodes = (data ?? []) as {
      guest: string
      title: string
      youtube_url: string
      mental_models: string[]
      guest_context: Record<string, string> | null
    }[]

    // Build map: model name → guest entries
    const modelMap = new Map<string, MentalModelGuest[]>()

    for (const ep of episodes) {
      if (!ep.mental_models || ep.mental_models.length === 0) continue
      for (const raw of ep.mental_models) {
        const name = raw.trim()
        if (!name) continue
        const existing = modelMap.get(name)
        const entry: MentalModelGuest = {
          guest: ep.guest,
          title: ep.title,
          youtube_url: ep.youtube_url ?? '',
          guest_context: ep.guest_context ?? null,
        }
        if (existing) {
          existing.push(entry)
        } else {
          modelMap.set(name, [entry])
        }
      }
    }

    // Convert to sorted array (most referenced first)
    const models: MentalModel[] = Array.from(modelMap.entries())
      .map(([name, guests]) => ({ name, count: guests.length, guests }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

    const response: MentalModelsApiResponse = {
      models,
      total_models: models.length,
      total_episodes: episodes.length,
    }

    return Response.json(response)
  } catch (err) {
    console.error('/api/mental-models error:', err)
    return Response.json(
      { error: (err as Error).message ?? 'Internal server error' },
      { status: 500 }
    )
  }
}
