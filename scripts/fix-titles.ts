/**
 * Episodes with no video whose title names a different guest (copied frontmatter)
 * get a neutral "<Guest> on Lenny's Podcast" title. The guest is whoever speaks most
 * in the transcript besides Lenny. Also updates source cards in precomputed answers.
 *
 *   npx tsx scripts/fix-titles.ts           # dry run
 *   npx tsx scripts/fix-titles.ts --apply
 */
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import { supabase, TRANSCRIPTS_DIR } from './lib/db'
import { EVAL_DIR } from './eval/common'
import { parseTranscript, isGuestSpeaker } from './lib/transcript'

async function main() {
  const apply = process.argv.includes('--apply')
  const { data, error } = await supabase.from('episodes').select('id, guest, slug, title').is('video_id', null).order('slug')
  if (error) throw new Error(error.message)

  const fixes: { id: string; slug: string; guest: string; from: string; to: string }[] = []
  for (const e of data as { id: string; guest: string; slug: string; title: string }[]) {
    const turns = parseTranscript(matter(fs.readFileSync(path.join(TRANSCRIPTS_DIR, e.slug, 'transcript.md'), 'utf8')).content)
    const words = new Map<string, number>()
    for (const t of turns) if (isGuestSpeaker(t.speaker)) words.set(t.speaker, (words.get(t.speaker) ?? 0) + t.text.length)
    const speaker = [...words.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!speaker || e.title.toLowerCase().includes(speaker.toLowerCase())) continue
    fixes.push({ id: e.id, slug: e.slug, guest: e.guest, from: e.title, to: `${speaker} on Lenny's Podcast` })
  }

  for (const f of fixes) console.log(`  ${f.slug.padEnd(16)} "${f.from.slice(0, 60)}"  →  "${f.to}"`)
  console.log(`${fixes.length} titles to fix`)
  if (!apply || fixes.length === 0) return

  const backup = path.join(EVAL_DIR, `episodes-backup-titles-${Date.now()}.json`)
  fs.writeFileSync(backup, JSON.stringify(fixes, null, 2) + '\n')
  for (const f of fixes) {
    const { error: upErr } = await supabase.from('episodes').update({ title: f.to }).eq('id', f.id)
    if (upErr) throw new Error(`${f.slug}: ${upErr.message}`)
  }
  console.log(`✓ updated ${fixes.length} titles (backup: ${backup})`)

  const preFile = path.resolve(process.cwd(), 'lib/precomputed-answers.json')
  const pre = JSON.parse(fs.readFileSync(preFile, 'utf8')) as Record<string, { sources: Record<string, string>[] }>
  const byTitle = new Map(fixes.map((f) => [`${f.guest}|${f.from}`, f.to]))
  let patched = 0
  for (const answer of Object.values(pre)) {
    for (const s of answer.sources) {
      const to = byTitle.get(`${s.guest}|${s.episode_title}`)
      if (to) { s.episode_title = to; patched++ }
    }
  }
  fs.writeFileSync(preFile, JSON.stringify(pre, null, 2))
  console.log(`✓ patched ${patched} source cards in lib/precomputed-answers.json`)
}

main().catch((e) => { console.error(e); process.exit(1) })
