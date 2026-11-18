/**
 * Ingests transcripts that aren't in the database yet: enriches each episode with
 * Claude, then builds and embeds its chunks_v2 windows.
 *
 *   npm run ingest
 *   npm run ingest -- --limit 5                 # first 5 transcript folders
 *   npm run ingest -- --episode ada-chen-rekhi  # one folder (slug)
 *
 * Episodes are keyed by folder slug. A new folder that repeats an existing
 * conversation is only caught by `npm run rechunk -- --all`, which skips duplicates.
 */

import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import Anthropic from '@anthropic-ai/sdk'
import { parseTranscript, mergeConsecutiveTurns, type Chunk } from './lib/transcript'
import { writeEpisodeChunks } from './lib/chunks-v2'
import { supabase, TRANSCRIPTS_DIR } from './lib/db'

const INTER_EPISODE_DELAY_MS = 500

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

interface Enrichment {
  guest_context: { industry: string; company_stage: string; guest_role: string; company: string; background: string }
  mental_models: string[]
  key_quotes: string[]
  topic_depth_scores: Record<string, number>
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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

async function enrichEpisode(guestName: string, turns: Chunk[]): Promise<Enrichment | null> {
  const guestSpeech = turns
    .filter((c) => c.is_guest)
    .map((c) => c.text)
    .join('\n\n')
    .slice(0, 6000)

  if (!guestSpeech) return null

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: ENRICHMENT_PROMPT(guestName, guestSpeech) }],
    })
    const raw = message.content[0].type === 'text' ? message.content[0].text : ''
    const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    return JSON.parse(json) as Enrichment
  } catch (err) {
    console.warn(`  ⚠️  Claude enrichment failed: ${(err as Error).message}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Main ingestion loop
// ---------------------------------------------------------------------------

async function processEpisode(episodeDir: string): Promise<'ingested' | 'skipped'> {
  const transcriptPath = path.join(episodeDir, 'transcript.md')
  if (!fs.existsSync(transcriptPath)) return 'skipped'

  const { data: fm, content } = matter(fs.readFileSync(transcriptPath, 'utf-8'))
  const frontmatter = fm as Frontmatter

  // Keyed on folder name: several folders share a video_id in their frontmatter.
  const slug = path.basename(episodeDir)
  const videoId = frontmatter.video_id || null

  const { data: existing } = await supabase.from('episodes').select('id').eq('slug', slug).maybeSingle()
  if (existing) {
    console.log(`  ↩  Already ingested, skipping.`)
    return 'skipped'
  }

  const turns = mergeConsecutiveTurns(parseTranscript(content))
  if (turns.length === 0) {
    console.warn(`  ⚠️  No speaker turns parsed, skipping.`)
    return 'skipped'
  }

  console.log(`  🤖 Enriching with Claude…`)
  const enrichment = await enrichEpisode(frontmatter.guest, turns)

  const { data: episodeRow, error: epErr } = await supabase
    .from('episodes')
    .insert({
      slug,
      guest: frontmatter.guest,
      title: frontmatter.title,
      youtube_url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
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

  if (epErr || !episodeRow) throw new Error(`Supabase episode insert failed: ${epErr?.message}`)

  console.log(`  🔢 Chunking and embedding…`)
  const count = await writeEpisodeChunks(supabase, { id: episodeRow.id, guest: frontmatter.guest, title: frontmatter.title }, content)
  console.log(`  ✓  ${count} chunks stored.`)
  return 'ingested'
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

  let ingested = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < episodeDirs.length; i++) {
    const dir = episodeDirs[i]
    console.log(`[${i + 1}/${episodeDirs.length}] ${path.basename(dir)}`)
    try {
      if ((await processEpisode(dir)) === 'ingested') ingested++
      else skipped++
    } catch (err) {
      console.error(`  ✗  ${(err as Error).message}`)
      failed++
    }
    if (i < episodeDirs.length - 1) await new Promise((r) => setTimeout(r, INTER_EPISODE_DELAY_MS))
  }

  console.log(`\nDone. ✓ ${ingested} ingested  ↩ ${skipped} skipped  ✗ ${failed} failed`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
