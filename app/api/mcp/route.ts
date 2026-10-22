import { NextRequest } from 'next/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import * as z from 'zod/v4'

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
}

// ── Prompts ───────────────────────────────────────────────────────────────────

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
    const text = msg.content[0].type === 'text' ? msg.content[0].text.trim() : ''
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
    throw new Error(`Voyage API error ${res.status}: ${await res.text()}`)
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] }
  return data.data[0].embedding
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireAuth(req: NextRequest): Response | null {
  const apiKey = process.env.MCP_API_KEY
  if (!apiKey) {
    return Response.json({ error: 'MCP_API_KEY not configured' }, { status: 500 })
  }
  const bearer = req.headers.get('authorization') ?? ''
  const xApiKey = req.headers.get('x-api-key') ?? ''
  if (bearer !== `Bearer ${apiKey}` && xApiKey !== apiKey) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

// ── MCP Server factory ────────────────────────────────────────────────────────

function buildMcpServer(): McpServer {
  const mcp = new McpServer({ name: 'chorus-mcp', version: '1.0.0' })

  // ── Tool: ask ──────────────────────────────────────────────────────────────
  mcp.registerTool(
    'ask',
    {
      title: 'Ask Chorus',
      description:
        'Ask any question about product management, growth, or leadership and get a synthesized answer drawn from 270 episodes of Lenny\'s Podcast. Runs the full pipeline: query rewrite → semantic search → Claude synthesis.',
      inputSchema: {
        question: z.string().describe('The question to ask'),
      },
    },
    async ({ question }) => {
      try {
        const rewritten = await rewriteQuery(question)
        const embedding = await embedQuery(rewritten)

        const { data: rawChunks, error: rpcError } = await supabase.rpc('match_chunks', {
          query_embedding: embedding,
          query_text: rewritten,
          match_count: 10,
        })

        if (rpcError) {
          return { content: [{ type: 'text' as const, text: `Search error: ${rpcError.message}` }], isError: true }
        }

        const chunks = (rawChunks ?? []) as ChunkMatch[]
        if (chunks.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No relevant content found for this question.' }] }
        }

        // Dedup — top 4 unique guests
        const seen = new Set<string>()
        const topChunks: ChunkMatch[] = []
        for (const chunk of chunks) {
          if (!seen.has(chunk.guest)) { seen.add(chunk.guest); topChunks.push(chunk) }
          if (topChunks.length === 4) break
        }

        // Claude synthesis (non-streaming for MCP)
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 900,
          system: [{ type: 'text', text: SYNTHESIS_SYSTEM, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: `A product leader has asked: "${rewritten}"\n\nBelow are the most relevant insights from past guest interviews:\n\n${buildContext(topChunks)}\n\nWrite a high-signal answer using only these excerpts.` }],
        })

        const raw = msg.content[0].type === 'text' ? msg.content[0].text : ''

        // Parse NDJSON output
        type SynthesisObj = { type: 'synthesis'; sections: { header: string; content: string }[]; bottom_line: string }
        type VoiceObj = { type: 'voice'; guest: string; summary: string; relevant: boolean }
        type MetaObj = { type: 'meta'; consensus: string | null; contrarian: string | null }

        let synthesis: SynthesisObj | null = null
        const voices: VoiceObj[] = []
        let meta: MetaObj | null = null

        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line.trim()) as { type: string }
            if (obj.type === 'synthesis') synthesis = obj as SynthesisObj
            else if (obj.type === 'voice') voices.push(obj as VoiceObj)
            else if (obj.type === 'meta') meta = obj as MetaObj
          } catch { /* skip malformed lines */ }
        }

        // Format as readable markdown
        const lines: string[] = [`**Query:** ${rewritten}`, '']

        for (const section of (synthesis?.sections ?? [])) {
          lines.push(`### ${section.header}`, section.content, '')
        }
        if (synthesis?.bottom_line) lines.push(`**Bottom line:** ${synthesis.bottom_line}`, '')
        if (meta?.consensus) lines.push(`**Consensus:** ${meta.consensus}`, '')
        if (meta?.contrarian) lines.push(`**Contrarian take:** ${meta.contrarian}`, '')

        lines.push('**Sources:**')
        for (const c of topChunks) {
          lines.push(`- **${c.guest}** — "${c.title}"\n  ${buildYouTubeUrl(c.video_id, c.timestamp_start)}`)
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  // ── Tool: search ──────────────────────────────────────────────────────────
  mcp.registerTool(
    'search',
    {
      title: 'Search Chorus',
      description:
        "Semantic search across 270 episodes of Lenny's Podcast. Returns relevant transcript chunks with guest and episode info. Use this when you want raw excerpts rather than a synthesized answer.",
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
        const embedding = await embedQuery(query)

        const { data: rawChunks, error } = await supabase.rpc('match_chunks', {
          query_embedding: embedding,
          query_text: query,
          match_count: limit,
        })

        if (error) {
          return { content: [{ type: 'text' as const, text: `Search error: ${error.message}` }], isError: true }
        }

        const chunks = (rawChunks ?? []) as ChunkMatch[]
        if (chunks.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No results found.' }] }
        }

        const text = chunks
          .map(
            (c, i) =>
              `${i + 1}. **${c.guest}** — "${c.title}"\n   ${buildYouTubeUrl(c.video_id, c.timestamp_start)}\n   > "${c.text.slice(0, 300)}${c.text.length > 300 ? '…' : ''}"\n   Similarity: ${c.similarity.toFixed(3)}`
          )
          .join('\n\n')

        return { content: [{ type: 'text' as const, text }] }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
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

        if (error) {
          return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }], isError: true }
        }

        if (!data || data.length === 0) {
          return { content: [{ type: 'text' as const, text: `No guest found matching "${name}". Try list_guests to see all available guests.` }] }
        }

        const episodes = data as { guest: string; title: string; youtube_url: string; video_id: string; publish_date: string; description: string }[]
        const guestName = episodes[0].guest
        const lines = [`**${guestName}** — ${episodes.length} episode(s)`, '']

        for (const ep of episodes) {
          lines.push(`- "${ep.title}" (${ep.publish_date ?? 'n/a'})`)
          lines.push(`  ${ep.youtube_url || `https://www.youtube.com/watch?v=${ep.video_id}`}`)
          if (ep.description) lines.push(`  ${ep.description.slice(0, 120)}${ep.description.length > 120 ? '…' : ''}`)
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
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

        if (error) {
          return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }], isError: true }
        }

        const seen = new Set<string>()
        const guests: string[] = []
        for (const row of (data ?? []) as { guest: string }[]) {
          if (!seen.has(row.guest)) { seen.add(row.guest); guests.push(row.guest) }
        }

        return {
          content: [{ type: 'text' as const, text: `${guests.length} guests in the database:\n\n${guests.join('\n')}` }],
        }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
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
  const err = requireAuth(req)
  if (err) return err
  return handleMcpRequest(req)
}

export async function POST(req: NextRequest) {
  const err = requireAuth(req)
  if (err) return err
  return handleMcpRequest(req)
}

export async function DELETE(req: NextRequest) {
  const err = requireAuth(req)
  if (err) return err
  return handleMcpRequest(req)
}
