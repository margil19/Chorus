/**
 * Rebuilds chunks_v2 (guest answer windows) from the local transcripts.
 *
 *   npm run rechunk -- --all --dry-run         # stats only, no API calls
 *   npm run rechunk -- --all
 *   npm run rechunk -- --episodes ids.json     # JSON array of { id }
 */
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import { contentFingerprint, fingerprintSimilarity } from './lib/transcript'
import { previewEpisodeChunks, writeEpisodeChunks } from './lib/chunks-v2'
import { supabase, TRANSCRIPTS_DIR } from './lib/db'
import { voyageTokens } from './lib/voyage'

interface EpisodeRow { id: string; guest: string; title: string; slug: string }

async function loadEpisodes(): Promise<{ all: EpisodeRow[]; selected: Set<string> }> {
  const args = process.argv.slice(2)
  const { data, error } = await supabase.from('episodes').select('id, guest, title, slug').order('slug')
  if (error) throw new Error(error.message)
  const all = data as EpisodeRow[]
  if (all.some((e) => !e.slug)) throw new Error('episodes without slug — run scripts/fix-episodes.ts --apply first')
  if (args.includes('--all')) return { all, selected: new Set(all.map((e) => e.id)) }
  const fileIdx = args.indexOf('--episodes')
  if (fileIdx < 0) throw new Error('pass --all or --episodes <file.json>')
  return { all, selected: new Set((JSON.parse(fs.readFileSync(path.resolve(args[fileIdx + 1]), 'utf8')) as { id: string }[]).map((e) => e.id)) }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const { all, selected } = await loadEpisodes()

  // Some folders hold another episode's transcript under a new title. Keep the first
  // (by slug) of each conversation so search doesn't return the same passage twice.
  const seen: { slug: string; fp: Set<string> }[] = []
  const contentBySlug = new Map<string, string>()
  const duplicateOf = new Map<string, string>()
  for (const ep of all) {
    const { content } = matter(fs.readFileSync(path.join(TRANSCRIPTS_DIR, ep.slug, 'transcript.md'), 'utf8'))
    contentBySlug.set(ep.slug, content)
    const fp = contentFingerprint(content)
    const dup = seen.find((s) => fingerprintSimilarity(s.fp, fp) > 0.5)
    if (dup) duplicateOf.set(ep.slug, dup.slug)
    else seen.push({ slug: ep.slug, fp })
  }

  const episodes = all.filter((e) => selected.has(e.id))
  console.log(`${dryRun ? '[dry run] ' : ''}Re-chunking ${episodes.length} episode(s)…\n`)

  let totalChunks = 0
  for (const [n, ep] of episodes.entries()) {
    const label = `[${n + 1}/${episodes.length}] ${ep.guest}`
    if (duplicateOf.has(ep.slug)) {
      console.log(`${label}: duplicate of ${duplicateOf.get(ep.slug)}, no chunks`)
      if (!dryRun) await supabase.from('chunks_v2').delete().eq('episode_id', ep.id)
      continue
    }
    const content = contentBySlug.get(ep.slug)!
    const count = dryRun
      ? previewEpisodeChunks(ep, content).windows.length
      : await writeEpisodeChunks(supabase, ep, content)
    totalChunks += count
    console.log(`${label}: ${count} chunks${dryRun ? '' : ' ✓'}`)
  }

  console.log(`\n${totalChunks} chunks`)
  if (!dryRun) console.log(`Voyage tokens billed: ${voyageTokens()}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
