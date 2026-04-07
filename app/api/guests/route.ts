import { createClient } from '@supabase/supabase-js'

// ── Client ────────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GuestsApiResponse {
  guests: string[]
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const { data, error } = await supabase
      .from('episodes')
      .select('guest')
      .order('guest', { ascending: true })

    if (error) {
      return Response.json({ error: error.message }, { status: 500 })
    }

    // Deduplicate while preserving sorted order
    const seen = new Set<string>()
    const guests: string[] = []
    for (const row of (data ?? []) as { guest: string }[]) {
      if (!seen.has(row.guest)) {
        seen.add(row.guest)
        guests.push(row.guest)
      }
    }

    return Response.json({ guests } satisfies GuestsApiResponse)
  } catch (err) {
    return Response.json(
      { error: (err as Error).message ?? 'Internal server error' },
      { status: 500 }
    )
  }
}
