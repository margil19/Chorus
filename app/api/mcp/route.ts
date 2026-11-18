import { NextRequest } from 'next/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import * as z from 'zod/v4'
import { answerQuestion, buildYouTubeUrl } from '@/lib/answer'
import { retrieve } from '@/lib/retrieval'

// ── Clients ──────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Auth ──────────────────────────────────────────────────────────────────────

async function deriveAccessToken(apiKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(apiKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('chorus-mcp-access-token-v1'))
  return Buffer.from(sig).toString('hex')
}

async function requireAuth(req: NextRequest): Promise<Response | null> {
  const apiKey = process.env.MCP_API_KEY
  if (!apiKey) {
    return Response.json({ error: 'MCP_API_KEY not configured' }, { status: 500 })
  }
  const bearerMatch = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  const xApiKey = req.headers.get('x-api-key') ?? ''
  const oauthToken = await deriveAccessToken(apiKey)
  if (bearerMatch !== apiKey && bearerMatch !== oauthToken && xApiKey !== apiKey) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

// ── MCP Server factory ────────────────────────────────────────────────────────

const errorResult = (err: unknown) => ({
  content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
  isError: true,
})

function buildMcpServer(): McpServer {
  const mcp = new McpServer({ name: 'chorus-mcp', version: '1.0.0' })

  // ── Tool: ask ──────────────────────────────────────────────────────────────
  mcp.registerTool(
    'ask',
    {
      title: 'Ask Chorus',
      description:
        'Ask any question about product management, growth, or leadership and get a synthesized answer drawn from 270 episodes of Lenny\'s Podcast. Runs the full pipeline: semantic search → rerank → Claude synthesis.',
      inputSchema: {
        question: z.string().describe('The question to ask'),
      },
    },
    async ({ question }) => {
      try {
        const answer = await answerQuestion(supabase, anthropic, question)
        if (!answer) {
          return { content: [{ type: 'text' as const, text: 'No relevant content found for this question.' }] }
        }

        const lines: string[] = []
        for (const section of answer.sections) lines.push(`### ${section.header}`, section.content, '')
        if (answer.bottom_line) lines.push(`**Bottom line:** ${answer.bottom_line}`, '')
        if (answer.consensus) lines.push(`**Consensus:** ${answer.consensus}`, '')
        if (answer.contrarian) lines.push(`**Contrarian take:** ${answer.contrarian}`, '')
        lines.push('**Sources:**')
        for (const s of answer.sources) {
          lines.push(`- **${s.guest}** — "${s.episode_title}"${s.youtube_url ? `\n  ${s.youtube_url}` : ''}`)
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  // ── Tool: search ──────────────────────────────────────────────────────────
  mcp.registerTool(
    'search',
    {
      title: 'Search Chorus',
      description:
        "Semantic search across 270 episodes of Lenny's Podcast. Returns relevant transcript passages with guest and episode info. Use this when you want raw excerpts rather than a synthesized answer.",
      inputSchema: {
        query: z.string().describe('Search query'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Number of results to return (default 5, max 20)'),
      },
    },
    async ({ query, limit = 5 }) => {
      try {
        const { chunks } = await retrieve(supabase, query, { limit, maxPerGuest: limit })
        if (chunks.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No results found.' }] }
        }

        const text = chunks
          .map((c, i) => {
            const url = buildYouTubeUrl(c.video_id, c.timestamp_start)
            const asked = c.question ? `   Lenny asked: "${c.question}"\n` : ''
            return `${i + 1}. **${c.guest}** — "${c.title}"${url ? `\n   ${url}` : ''}\n${asked}   > "${c.text}"\n   Relevance: ${(c.rerank_score ?? 0).toFixed(3)}`
          })
          .join('\n\n')

        return { content: [{ type: 'text' as const, text }] }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  // ── Tool: get_guest ───────────────────────────────────────────────────────
  mcp.registerTool(
    'get_guest',
    {
      title: 'Get Guest Profile',
      description:
        "Look up a guest's episodes by name. Supports partial matching (e.g. 'Shreyas' will find 'Shreyas Doshi'). Returns episode list with titles and YouTube links.",
      inputSchema: {
        name: z.string().describe('Guest name — exact or partial match'),
      },
    },
    async ({ name }) => {
      try {
        const { data, error } = await supabase
          .from('episodes')
          .select('guest, title, youtube_url, video_id, publish_date, description')
          .ilike('guest', `%${name}%`)
          .order('publish_date', { ascending: false })

        if (error) return errorResult(error)

        if (!data || data.length === 0) {
          return { content: [{ type: 'text' as const, text: `No guest found matching "${name}". Try list_guests to see all available guests.` }] }
        }

        const episodes = data as { guest: string; title: string; youtube_url: string | null; video_id: string | null; publish_date: string; description: string }[]
        const guestName = episodes[0].guest
        const lines = [`**${guestName}** — ${episodes.length} episode(s)`, '']

        for (const ep of episodes) {
          lines.push(`- "${ep.title}" (${ep.publish_date ?? 'n/a'})`)
          const url = ep.youtube_url || (ep.video_id ? `https://www.youtube.com/watch?v=${ep.video_id}` : '')
          if (url) lines.push(`  ${url}`)
          if (ep.description) lines.push(`  ${ep.description.slice(0, 120)}${ep.description.length > 120 ? '…' : ''}`)
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  // ── Tool: list_guests ─────────────────────────────────────────────────────
  mcp.registerTool(
    'list_guests',
    {
      title: 'List All Guests',
      description:
        "List every guest who has appeared on Lenny's Podcast in Chorus, sorted alphabetically. Use this for discovery or to find the exact name spelling before calling get_guest.",
    },
    async () => {
      try {
        const { data, error } = await supabase
          .from('episodes')
          .select('guest')
          .order('guest', { ascending: true })

        if (error) return errorResult(error)

        const seen = new Set<string>()
        const guests: string[] = []
        for (const row of (data ?? []) as { guest: string }[]) {
          if (!seen.has(row.guest)) { seen.add(row.guest); guests.push(row.guest) }
        }

        return {
          content: [{ type: 'text' as const, text: `${guests.length} guests in the database:\n\n${guests.join('\n')}` }],
        }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  return mcp
}

// ── Request handler ───────────────────────────────────────────────────────────

async function handleMcpRequest(req: NextRequest): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport()
  const server = buildMcpServer()
  await server.connect(transport)
  return transport.handleRequest(req)
}

// ── Route exports ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const err = await requireAuth(req)
  if (err) return err
  return handleMcpRequest(req)
}

export async function POST(req: NextRequest) {
  const err = await requireAuth(req)
  if (err) return err
  return handleMcpRequest(req)
}

export async function DELETE(req: NextRequest) {
  const err = await requireAuth(req)
  if (err) return err
  return handleMcpRequest(req)
}
