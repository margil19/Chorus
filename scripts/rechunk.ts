/**
 * Builds chunks_v2 (guest answer windows) from the local transcripts.
 * Leaves the `chunks` table and `episodes` rows untouched.
 *
 *   npx tsx scripts/rechunk.ts --dry-run                       # stats only, no API calls
 *   npx tsx scripts/rechunk.ts --episodes scripts/eval/pilot-episodes.json
 *   npx tsx scripts/rechunk.ts --all
 */
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import {
  parseTranscript, buildWindowChunks, embeddingText, contentFingerprint, fingerprintSimilarity,
} from './lib/transcript'
import { supabase, voyageEmbed, voyageTokens, TRANSCRIPTS_DIR } from './eval/common'

const EMBED_BATCH_SIZE = 64

interface EpisodeRow { id: string; guest: string; title: string; slug: string }

async function loadEpisodes(): Promise<{ all: EpisodeRow[]; selected: Set<string> }> {
  const args = process.argv.slice(2)
  const fileIdx = args.indexOf('--episodes')
  const { data, error } = await supabase.from('episodes').select('id, guest, title, slug').order('slug')
  if (error) throw new Error(error.message)
  const all = data as EpisodeRow[]
  if (all.some((e) => !e.slug)) throw new Error('episodes without slug — run scripts/fix-episodes.ts --apply first')
  if (args.includes('--all')) return { all, selected: new Set(all.map((e) => e.id)) }
  const file = fileIdx >= 0 ? args[fileIdx + 1] : 'scripts/eval/pilot-episodes.json'
  return { all, selected: new Set((JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as { id: string }[]).map((e) => e.id)) }
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
  let totalChars = 0
  for (const [n, ep] of episodes.entries()) {
    if (duplicateOf.has(ep.slug)) {
      console.log(`[${n + 1}/${episodes.length}] ${ep.guest}: duplicate of ${duplicateOf.get(ep.slug)}, no chunks`)
      if (!dryRun) await supabase.from('chunks_v2').delete().eq('episode_id', ep.id)
      continue
    }
    const windows = buildWindowChunks(parseTranscript(contentBySlug.get(ep.slug)!))
    const texts = windows.map((w) => embeddingText(ep.guest, ep.title, w))
    totalChunks += windows.length
    totalChars += texts.reduce((s, t) => s + t.length, 0)
    process.stdout.write(`[${n + 1}/${episodes.length}] ${ep.guest}: ${windows.length} chunks`)

    if (dryRun) { process.stdout.write('\n'); continue }

    const embeddings: number[][] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      embeddings.push(...(await voyageEmbed(texts.slice(i, i + EMBED_BATCH_SIZE), 'document')))
    }

    const { error: delErr } = await supabase.from('chunks_v2').delete().eq('episode_id', ep.id)
    if (delErr) throw new Error(`delete failed: ${delErr.message}`)
    const rows = windows.map((w, i) => ({
      episode_id: ep.id,
      speaker: w.speaker,
      timestamp_start: w.timestamp_start,
      question: w.question,
      segment_index: w.segment_index,
      window_index: w.window_index,
      text: w.text,
      embedding: `[${embeddings[i].join(',')}]`,
    }))
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabase.from('chunks_v2').insert(rows.slice(i, i + 200))
      if (error) throw new Error(`insert failed: ${error.message}`)
    }
    process.stdout.write(' ✓\n')
  }

  console.log(`\n${totalChunks} chunks, ~${Math.round(totalChars / 4 / 1000)}k tokens of embedding text (estimate)`)
  if (!dryRun) console.log(`Voyage tokens billed: ${voyageTokens}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
