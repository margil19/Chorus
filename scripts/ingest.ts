/**
 * Ingestion script: reads all podcast transcripts, enriches with Claude,
 * embeds with Voyage AI, and stores everything in Supabase.
 *
 * Usage:
 *   npx tsx scripts/ingest.ts
 *   npx tsx scripts/ingest.ts --limit 5        # process first 5 episodes
 *   npx tsx scripts/ingest.ts --episode ada-chen-rekhi  # single episode slug
 */

import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TRANSCRIPTS_DIR =
  process.env.TRANSCRIPTS_DIR ??
  '/Users/margilgandhi/projects/lennys-podcast-transcripts/episodes'

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_MODEL = 'voyage-3-large'
const EMBED_BATCH_SIZE = 50     // texts per Voyage request
const INTER_EPISODE_DELAY_MS = 500  // polite pause between episodes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Frontmatter {
  guest: string
  title: string
  youtube_url?: string
  video_id?: string
  publish_date?: string
  description?: string
  duration_seconds?: number
  duration?: string
  view_count?: number
  channel?: string
  keywords?: string[]
}

interface RawTurn {
  speaker: string
  timestamp: string
  text: string
}

interface Chunk {
  speaker: string
  is_guest: boolean
  timestamp_start: string
  text: string
}

interface GuestContext {
  industry: string
  company_stage: string
  guest_role: string
  company: string
  background: string
}

interface Enrichment {
  guest_context: GuestContext
  mental_models: string[]
  key_quotes: string[]
  topic_depth_scores: Record<string, number>
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

/**
 * Three header formats are handled:
 *
 * Format A — HH:MM:SS or MM:SS timestamp with named speaker:
 *   "Speaker Name (HH:MM:SS):"  /  "Speaker Name (MM:SS):"
 *
 * Format B — timestamp-only continuation (carry-forward speaker):
 *   "(HH:MM:SS):"  /  "(MM:SS):"
 *
 * Format C — no timestamp, speaker name only:
 *   "Speaker Name:"
 *   (timestamp_start is set to '' for these turns)
 */

// Matches HH:MM:SS or MM:SS
const TS = /\d{2}:\d{2}(?::\d{2})?/

const SPEAKER_WITH_TS   = new RegExp(`^([^(]+?)\\s*\\((${TS.source})\\):\\s*$`)
const CONTINUATION_TS   = new RegExp(`^\\((${TS.source})\\):\\s*$`)
// Uppercase-led name, no parens, ends with colon — e.g. "Lenny:" or "Casey Winters:"
const SPEAKER_NO_TS     = /^([A-Z][^:(\n]+?):\s*$/

function parseTranscript(content: string): RawTurn[] {
  const lines = content.split('\n')
  const turns: RawTurn[] = []

  let currentSpeaker = ''
  let currentTimestamp = ''
  let currentLines: string[] = []
  // Track whether we have seen any header so we don't collect preamble text
  let started = false

  function flush() {
    const text = currentLines.join(' ').trim()
    if (text && started) {
      turns.push({ speaker: currentSpeaker, timestamp: currentTimestamp, text })
    }
    currentLines = []
  }

  for (const line of lines) {
    const speakerTsMatch = line.match(SPEAKER_WITH_TS)
    const contTsMatch    = line.match(CONTINUATION_TS)
    const speakerNoTs    = !speakerTsMatch && !contTsMatch
                          ? line.match(SPEAKER_NO_TS)
                          : null

    if (speakerTsMatch) {
      flush()
      currentSpeaker    = speakerTsMatch[1].trim()
      currentTimestamp  = speakerTsMatch[2]
      started = true
    } else if (contTsMatch) {
      flush()
      // carry-forward: currentSpeaker unchanged
      currentTimestamp  = contTsMatch[1]
      started = true
    } else if (speakerNoTs) {
      flush()
      currentSpeaker    = speakerNoTs[1].trim()
      currentTimestamp  = ''
      started = true
    } else if (line.trim() && started) {
      currentLines.push(line.trim())
    }
  }

  flush()
  return turns
}

/**
 * Merge consecutive turns from the same speaker into a single chunk.
 * Keeps the earliest timestamp as timestamp_start.
 */
function mergeConsecutiveTurns(turns: RawTurn[]): Chunk[] {
  const chunks: Chunk[] = []

  for (const turn of turns) {
    if (!turn.text) continue

    const isGuest =
      turn.speaker !== '' &&
      !turn.speaker.toLowerCase().includes('lenny')

    const last = chunks[chunks.length - 1]
    if (last && last.speaker === turn.speaker) {
      last.text += ' ' + turn.text
    } else {
      chunks.push({
        speaker: turn.speaker,
        is_guest: isGuest,
        timestamp_start: turn.timestamp,
        text: turn.text,
      })
    }
  }

  return chunks
}

// ---------------------------------------------------------------------------
// Claude enrichment
// ---------------------------------------------------------------------------

const ENRICHMENT_PROMPT = (guestName: string, guestSpeech: string) => `
You are analyzing a podcast transcript from Lenny's Podcast.
Guest: ${guestName}

Below is a sample of the guest's speech from this episode. Extract the following as valid JSON (no markdown, no extra text):

{
  "guest_context": {
    "industry": "B2B" | "B2C" | "B2B/B2C" | "Consumer" | "Developer Tools" | other short label,
    "company_stage": e.g. "Startup" | "Growth" | "Scale" | "Enterprise" | "Public",
    "guest_role": e.g. "CPO" | "CEO" | "PM" | "Founder" | "Investor" | "Coach" | "Author",
    "company": "Primary company or companies the guest is associated with",
    "background": "1–2 sentence background summary"
  },
  "mental_models": ["array of 3–8 key mental models, frameworks, or named concepts the guest introduces"],
  "key_quotes": ["array of 3–5 memorable direct quotes from the guest — verbatim, not paraphrased"],
  "topic_depth_scores": {
    "product_strategy": 0–10,
    "growth": 0–10,
    "hiring": 0–10,
    "leadership": 0–10,
    "user_research": 0–10,
    "metrics": 0–10,
    "culture": 0–10,
    "pricing": 0–10,
    "roadmap": 0–10,
    "career_development": 0–10,
    "company_building": 0–10,
    "fundraising": 0–10,
    "marketing": 0–10
  }
}

Guest speech excerpt:
${guestSpeech}
`.trim()

async function enrichEpisode(
  guestName: string,
  chunks: Chunk[]
): Promise<Enrichment | null> {
  // Use first ~6000 chars of guest speech only
  const guestSpeech = chunks
    .filter((c) => c.is_guest)
    .map((c) => c.text)
    .join('\n\n')
    .slice(0, 6000)

  if (!guestSpeech) return null

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: ENRICHMENT_PROMPT(guestName, guestSpeech),
        },
      ],
    })

    const raw =
      message.content[0].type === 'text' ? message.content[0].text : ''

    const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    return JSON.parse(json) as Enrichment
  } catch (err) {
    console.warn(`  ⚠️  Claude enrichment failed: ${(err as Error).message}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Voyage AI embeddings
// ---------------------------------------------------------------------------

async function embedTexts(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = []

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE)

    const res = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: VOYAGE_MODEL, input: batch }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Voyage API error ${res.status}: ${body}`)
    }

    const data = (await res.json()) as {
      data: { embedding: number[]; index: number }[]
    }

    // Sort by index to preserve order
    const sorted = data.data.sort((a, b) => a.index - b.index)
    embeddings.push(...sorted.map((d) => d.embedding))
  }

  return embeddings
}

// ---------------------------------------------------------------------------
// Main ingestion loop
// ---------------------------------------------------------------------------

async function processEpisode(episodeDir: string): Promise<void> {
  const transcriptPath = path.join(episodeDir, 'transcript.md')
  if (!fs.existsSync(transcriptPath)) return

  const raw = fs.readFileSync(transcriptPath, 'utf-8')
  const { data: fm, content } = matter(raw)
  const frontmatter = fm as Frontmatter

  const slug = path.basename(episodeDir)
  const videoId = frontmatter.video_id ?? slug

  // Skip if already ingested
  const { data: existing } = await supabase
    .from('episodes')
    .select('id')
    .eq('video_id', videoId)
    .single()

  if (existing) {
    console.log(`  ↩  Already ingested, skipping.`)
    return
  }

  // Parse & chunk
  const rawTurns = parseTranscript(content)
  const chunks = mergeConsecutiveTurns(rawTurns)

  if (chunks.length === 0) {
    console.warn(`  ⚠️  No chunks parsed, skipping.`)
    return
  }

  // Claude enrichment
  console.log(`  🤖 Enriching with Claude…`)
  const enrichment = await enrichEpisode(frontmatter.guest, chunks)

  // Insert episode row
  const { data: episodeRow, error: epErr } = await supabase
    .from('episodes')
    .insert({
      guest: frontmatter.guest,
      title: frontmatter.title,
      youtube_url: frontmatter.youtube_url ?? null,
      video_id: videoId,
      publish_date: frontmatter.publish_date ?? null,
      description: frontmatter.description ?? null,
      duration_seconds: frontmatter.duration_seconds ?? null,
      duration: frontmatter.duration ?? null,
      view_count: frontmatter.view_count ?? null,
      channel: frontmatter.channel ?? null,
      keywords: frontmatter.keywords ?? [],
      guest_context: enrichment?.guest_context ?? null,
      mental_models: enrichment?.mental_models ?? [],
      key_quotes: enrichment?.key_quotes ?? [],
      topic_depth_scores: enrichment?.topic_depth_scores ?? null,
    })
    .select('id')
    .single()

  if (epErr || !episodeRow) {
    throw new Error(`Supabase episode insert failed: ${epErr?.message}`)
  }

  const episodeId = episodeRow.id

  // Embed chunks
  console.log(`  🔢 Embedding ${chunks.length} chunks…`)
  const texts = chunks.map((c) => c.text)
  const embeddings = await embedTexts(texts)

  // Insert chunks
  // Embeddings are formatted as pgvector text literals ("[v1,v2,…]") so
  // Postgres casts them to halfvec(1024) based on the column type.
  const chunkRows = chunks.map((c, i) => ({
    episode_id: episodeId,
    speaker: c.speaker,
    is_guest: c.is_guest,
    timestamp_start: c.timestamp_start,
    text: c.text,
    embedding: `[${embeddings[i].join(',')}]`,
  }))

  const { error: chunkErr } = await supabase.from('chunks').insert(chunkRows)
  if (chunkErr) {
    throw new Error(`Supabase chunks insert failed: ${chunkErr.message}`)
  }

  console.log(`  ✓  ${chunks.length} chunks stored.`)
}

async function main() {
  const args = process.argv.slice(2)
  const limitIdx = args.indexOf('--limit')
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity
  const episodeIdx = args.indexOf('--episode')
  const singleEpisode = episodeIdx >= 0 ? args[episodeIdx + 1] : null

  let episodeDirs = fs
    .readdirSync(TRANSCRIPTS_DIR)
    .filter((d) => fs.statSync(path.join(TRANSCRIPTS_DIR, d)).isDirectory())
    .map((d) => path.join(TRANSCRIPTS_DIR, d))
    .sort()

  if (singleEpisode) {
    episodeDirs = episodeDirs.filter((d) => path.basename(d) === singleEpisode)
    if (episodeDirs.length === 0) {
      console.error(`No episode directory found for slug: ${singleEpisode}`)
      process.exit(1)
    }
  } else if (isFinite(limit)) {
    episodeDirs = episodeDirs.slice(0, limit)
  }

  console.log(`\nIngesting ${episodeDirs.length} episode(s)…\n`)

  let success = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < episodeDirs.length; i++) {
    const dir = episodeDirs[i]
    const slug = path.basename(dir)
    console.log(`[${i + 1}/${episodeDirs.length}] ${slug}`)

    try {
      const before = success + skipped
      await processEpisode(dir)
      if (success + skipped === before) skipped++  // was already ingested
      else success++
    } catch (err) {
      console.error(`  ✗  ${(err as Error).message}`)
      failed++
    }

    if (i < episodeDirs.length - 1) {
      await new Promise((r) => setTimeout(r, INTER_EPISODE_DELAY_MS))
    }
  }

  console.log(`\nDone. ✓ ${success} ingested  ↩ ${skipped} skipped  ✗ ${failed} failed`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
