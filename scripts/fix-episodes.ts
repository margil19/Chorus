/**
 * One-off repair of the episodes table (requires the episodes.slug column in scripts/schema.sql):
 *  1. backfill `slug` on existing rows with the folder ingest.ts actually used
 *  2. move video_ids that YouTube says belong to another folder's episode
 *     (input: scripts/eval/transcript-audit.json from audit-transcripts.ts)
 *  3. insert episodes ingest.ts skipped because their folder shared a video_id
 *
 *   npx tsx scripts/fix-episodes.ts            # dry run, prints the plan
 *   npx tsx scripts/fix-episodes.ts --apply
 */
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import Anthropic from '@anthropic-ai/sdk'
import { supabase, TRANSCRIPTS_DIR } from './lib/db'
import { EVAL_DIR } from './eval/common'
import { parseTranscript, mergeConsecutiveTurns } from './lib/transcript'

// Not guest interviews: a promo, and a montage of many guests under one fake "guest".
const EXCLUDE = new Set(['teaser_2021', 'interview-q-compilation'])

interface AuditRow { slug: string; guest: string; video_id: string; duplicateOf: string | null; videoOwner: string | null }

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Same enrichment as ingest.ts so new rows look like existing ones.
async function enrich(guest: string, content: string) {
  const speech = mergeConsecutiveTurns(parseTranscript(content)).filter((c) => c.is_guest).map((c) => c.text).join('\n\n').slice(0, 6000)
  if (!speech) return null
  const prompt = `You are analyzing a podcast transcript from Lenny's Podcast.
Guest: ${guest}

Below is a sample of the guest's speech from this episode. Extract the following as valid JSON (no markdown, no extra text):

{
  "guest_context": {"industry": "...", "company_stage": "...", "guest_role": "...", "company": "...", "background": "1–2 sentence background summary"},
  "mental_models": ["3–8 key mental models, frameworks, or named concepts the guest introduces"],
  "key_quotes": ["3–5 memorable direct quotes from the guest — verbatim"],
  "topic_depth_scores": {"product_strategy": 0, "growth": 0, "hiring": 0, "leadership": 0, "user_research": 0, "metrics": 0, "culture": 0, "pricing": 0, "roadmap": 0, "career_development": 0, "company_building": 0, "fundraising": 0, "marketing": 0}
}
(topic_depth_scores are 0–10)

Guest speech excerpt:
${speech}`
  try {
    const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] })
    const raw = msg.content[0].type === 'text' ? msg.content[0].text : ''
    return JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim())
  } catch (e) {
    console.warn(`  ⚠️  enrichment failed for ${guest}: ${(e as Error).message}`)
    return null
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const audit = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'transcript-audit.json'), 'utf8')) as AuditRow[]
  const bySlug = new Map(audit.map((r) => [r.slug, r]))
  const root = (slug: string): string => { const r = bySlug.get(slug)!; return r.duplicateOf ? root(r.duplicateOf) : slug }

  const { data, error } = await supabase.from('episodes').select('*')
  if (error) throw new Error(error.message)
  const episodes = (data as { id: string; guest: string; video_id: string | null; youtube_url: string | null; slug?: string | null }[])
    .map(({ id, guest, video_id, youtube_url, slug }) => ({ id, guest, video_id, youtube_url, slug: slug ?? null }))
  if (apply && !('slug' in (data[0] ?? {}))) throw new Error('add the episodes.slug column (scripts/schema.sql) first')

  // 1. Folder each existing row came from: ingest.ts keyed on (frontmatter.video_id ?? slug), first sorted folder wins.
  const keyToSlug = new Map<string, string>()
  for (const slug of fs.readdirSync(TRANSCRIPTS_DIR).sort()) {
    const file = path.join(TRANSCRIPTS_DIR, slug, 'transcript.md')
    if (!fs.existsSync(file)) continue
    const fm = matter(fs.readFileSync(file, 'utf8')).data as { video_id?: string }
    const key = fm.video_id ?? slug
    if (!keyToSlug.has(key)) keyToSlug.set(key, slug)
  }
  const slugOf = new Map(episodes.map((e) => [e.id, e.slug ?? keyToSlug.get(e.video_id ?? '') ?? null]))
  const unmapped = episodes.filter((e) => !slugOf.get(e.id))
  if (unmapped.length) throw new Error(`no folder for: ${unmapped.map((e) => e.guest).join(', ')}`)
  const inDbSlugs = new Set(slugOf.values() as Iterable<string>)

  // 2. Video ids held by the wrong row. The rightful owner gets it only if it exists after this run.
  const inDbRoots = new Set([...inDbSlugs].map(root))
  const toAdd = audit.filter((r) => !EXCLUDE.has(r.slug) && !r.duplicateOf && !inDbRoots.has(r.slug))
  const willExist = new Set([...inDbSlugs, ...toAdd.map((r) => r.slug)])
  const moves = episodes
    .map((e) => ({ e, slug: slugOf.get(e.id)!, a: bySlug.get(slugOf.get(e.id)!)! }))
    // Clear only when YouTube's title clearly names another folder's guest, or the "id" is a
    // folder-name placeholder. Unresolved matches (e.g. a misspelled guest name) are kept.
    .filter(({ e, slug, a }) => e.video_id && ((a.videoOwner && root(a.videoOwner) !== root(slug)) || e.video_id === slug))
    .map(({ e, slug, a }) => ({ e, slug, owner: e.video_id !== slug && a.videoOwner && willExist.has(a.videoOwner) && !bySlug.get(a.videoOwner)!.duplicateOf ? a.videoOwner : null }))
  const videoFor = new Map(moves.filter((m) => m.owner).map((m) => [m.owner!, m.e.video_id!]))

  console.log(`${apply ? '' : '[dry run] '}episodes in DB: ${episodes.length}`)
  console.log(`backfill slug: ${episodes.filter((e) => !e.slug).length} rows`)
  console.log(`clear wrong video_id on ${moves.length} rows:`)
  for (const m of moves) {
    const to = m.e.video_id === m.slug ? '(placeholder, not a real video)' : m.owner ?? '(nobody — owner not in DB)'
    console.log(`  ${m.slug.padEnd(22)} ${m.e.video_id} → ${to}`)
  }
  console.log(`blank video_id → NULL: ${episodes.filter((e) => e.video_id === '').length} rows`)
  console.log(`insert ${toAdd.length} episodes:`)
  for (const r of toAdd) console.log(`  ${r.slug.padEnd(30)} video: ${videoFor.get(r.slug) ?? (r.videoOwner === r.slug && r.video_id && !moves.some((m) => m.e.video_id === r.video_id) ? r.video_id : 'none')}`)
  if (!apply) return

  const backup = path.join(EVAL_DIR, `episodes-backup-${Date.now()}.json`)
  fs.writeFileSync(backup, JSON.stringify(episodes, null, 2) + '\n')
  console.log(`\nbackup of previous slug/video values: ${backup}`)

  for (const e of episodes) {
    const clear = moves.some((m) => m.e.id === e.id) || e.video_id === ''
    const { error: upErr } = await supabase.from('episodes')
      .update({ slug: slugOf.get(e.id), ...(clear && { video_id: null, youtube_url: null }) })
      .eq('id', e.id)
    if (upErr) throw new Error(`update ${e.guest}: ${upErr.message}`)
  }
  console.log(`✓ updated ${episodes.length} existing rows`)

  for (const r of toAdd) {
    const { data: fm, content } = matter(fs.readFileSync(path.join(TRANSCRIPTS_DIR, r.slug, 'transcript.md'), 'utf8'))
    const videoId = videoFor.get(r.slug) ?? (r.videoOwner === r.slug && r.video_id ? r.video_id : null)
    process.stdout.write(`  + ${r.slug} … `)
    const enrichment = await enrich(fm.guest, content)
    const { error: insErr } = await supabase.from('episodes').insert({
      slug: r.slug,
      guest: fm.guest,
      title: fm.title,
      youtube_url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
      video_id: videoId,
      publish_date: fm.publish_date ?? null,
      description: fm.description ?? null,
      duration_seconds: fm.duration_seconds ?? null,
      duration: fm.duration ?? null,
      view_count: fm.view_count ?? null,
      channel: fm.channel ?? null,
      keywords: fm.keywords ?? [],
      guest_context: enrichment?.guest_context ?? null,
      mental_models: enrichment?.mental_models ?? [],
      key_quotes: enrichment?.key_quotes ?? [],
      topic_depth_scores: enrichment?.topic_depth_scores ?? null,
    })
    if (insErr) throw new Error(`insert ${r.slug}: ${insErr.message}`)
    console.log('✓')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
