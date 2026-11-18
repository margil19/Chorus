/**
 * Finds YouTube videos for episodes with no video_id. Many of these rows also carry
 * another episode's title (copied frontmatter), so episodes are identified by who
 * speaks in the transcript, searched on YouTube, and matched on Lenny's channel by
 * video length ≈ last transcript timestamp.
 *
 *   npx tsx scripts/find-videos.ts                          # dry run
 *   npx tsx scripts/find-videos.ts --apply --skip slug,slug  # write video_id, youtube_url, title (+ backup)
 *
 * Review the dry run first: a "length only" match can be a coincidence (check the full
 * YouTube title against the transcript) and should be passed to --skip if wrong.
 */
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import { supabase, TRANSCRIPTS_DIR, EVAL_DIR } from './eval/common'
import { parseTranscript, isGuestSpeaker } from './lib/transcript'

const LENGTH_TOLERANCE_S = 90
const CHANNEL = "Lenny's Podcast"

interface Candidate { id: string; title: string; owner: string; seconds: number }

const toSeconds = (ts: string) => ts.split(':').map(Number).reduce((s, n) => s * 60 + n, 0)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function youtubeSearch(query: string, attempt = 1): Promise<Candidate[]> {
  await sleep(1500)
  let html: string
  try {
    const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
      headers: { 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': 'Mozilla/5.0' },
    })
    html = await res.text()
  } catch (err) {
    // YouTube answers bursts with redirect loops; back off and retry.
    if (attempt < 4) { await sleep(5000 * attempt); return youtubeSearch(query, attempt + 1) }
    console.warn(`  search failed for "${query}": ${(err as Error).message}`)
    return []
  }
  const json = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)?.[1]
  if (!json) return []
  const out: Candidate[] = []
  const walk = (o: unknown) => {
    if (!o || typeof o !== 'object') return
    const v = (o as { videoRenderer?: Record<string, any> }).videoRenderer
    if (v?.lengthText?.simpleText) {
      out.push({ id: v.videoId, title: v.title?.runs?.[0]?.text ?? '', owner: v.ownerText?.runs?.[0]?.text ?? '', seconds: toSeconds(v.lengthText.simpleText) })
    }
    for (const k in o as object) walk((o as Record<string, unknown>)[k])
  }
  walk(JSON.parse(json))
  return out
}

async function main() {
  const apply = process.argv.includes('--apply')
  const skipIdx = process.argv.indexOf('--skip')
  const skip = new Set(skipIdx >= 0 ? process.argv[skipIdx + 1].split(',') : [])
  const { data: all, error } = await supabase.from('episodes').select('id, guest, slug, title, video_id, youtube_url')
  if (error) throw new Error(error.message)
  const episodes = all as { id: string; guest: string; slug: string; title: string; video_id: string | null; youtube_url: string | null }[]
  const taken = new Set(episodes.map((e) => e.video_id).filter(Boolean))
  const missing = episodes.filter((e) => !e.video_id && !skip.has(e.slug)).sort((a, b) => a.slug.localeCompare(b.slug))

  const found: { e: (typeof episodes)[number]; c: Candidate; speaker: string }[] = []
  for (const e of missing) {
    const turns = parseTranscript(matter(fs.readFileSync(path.join(TRANSCRIPTS_DIR, e.slug, 'transcript.md'), 'utf8')).content)
    if (turns.length === 0) { console.log(`  ${e.slug.padEnd(28)} — transcript has no turns, skipped`); continue }

    // The guest is whoever speaks most besides Lenny; the row's guest/title fields can be wrong.
    const words = new Map<string, number>()
    for (const t of turns) if (isGuestSpeaker(t.speaker)) words.set(t.speaker, (words.get(t.speaker) ?? 0) + t.text.length)
    const speaker = [...words.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? e.guest
    const lastTs = [...turns].reverse().find((t) => t.timestamp)?.timestamp
    const length = lastTs ? toSeconds(lastTs) : 0

    const seen = new Map<string, Candidate>()
    for (const q of [`${speaker} ${CHANNEL}`, `${speaker} Lenny Rachitsky`]) {
      for (const c of await youtubeSearch(q)) if (!seen.has(c.id)) seen.set(c.id, c)
    }
    const surname = speaker.split(/\s+/).pop()!.toLowerCase()
    const matches = [...seen.values()].filter(
      (c) => c.owner === CHANNEL && !taken.has(c.id) && length > 0 && c.seconds >= length && c.seconds - length <= LENGTH_TOLERANCE_S
    )
    const named = matches.filter((c) => c.title.toLowerCase().includes(surname))
    let pick = named.length === 1 ? named[0] : matches.length === 1 ? matches[0] : null
    let how = pick ? (pick.title.toLowerCase().includes(surname) ? 'name+length' : 'length only') : ''

    // No length match (e.g. transcript without timestamps): one untaken Lenny's Podcast
    // video with the guest's full name in the title. Flagged for review.
    if (!pick) {
      const fullName = [...seen.values()].filter(
        (c) => c.owner === CHANNEL && !taken.has(c.id) && c.title.toLowerCase().includes(speaker.toLowerCase())
      )
      if (fullName.length === 1) { pick = fullName[0]; how = 'NAME ONLY — review' }
    }

    const status = pick
      ? `${pick.id}  ${how}  ${Math.floor(pick.seconds / 60)}m  "${pick.title.slice(0, 70)}"`
      : `no unique match (${matches.length} by length${matches.length ? ': ' + matches.map((m) => `${m.id} "${m.title.slice(0, 40)}"`).join('; ') : ''})`
    console.log(`  ${e.slug.padEnd(28)} speaker=${speaker.padEnd(22)} transcript ends ${lastTs ?? '?'}  → ${status}`)
    if (pick) { found.push({ e, c: pick, speaker }); taken.add(pick.id) }
  }

  console.log(`\nmatched ${found.length} of ${missing.length}`)
  if (!apply || found.length === 0) return

  const backup = path.join(EVAL_DIR, `episodes-backup-videos-${Date.now()}.json`)
  fs.writeFileSync(backup, JSON.stringify(found.map(({ e }) => e), null, 2) + '\n')
  for (const { e, c } of found) {
    const { error: upErr } = await supabase.from('episodes')
      .update({ video_id: c.id, youtube_url: `https://www.youtube.com/watch?v=${c.id}`, title: c.title })
      .eq('id', e.id)
    if (upErr) throw new Error(`${e.slug}: ${upErr.message}`)
  }
  console.log(`✓ updated ${found.length} episodes (backup: ${backup})`)

  // Precomputed answers store source cards with the old (empty) video; refresh them.
  const preFile = path.resolve(process.cwd(), 'lib/precomputed-answers.json')
  const pre = JSON.parse(fs.readFileSync(preFile, 'utf8')) as Record<string, { sources: Record<string, string>[] }>
  const byGuest = new Map(found.map(({ e, c }) => [e.guest, c]))
  let patched = 0
  for (const answer of Object.values(pre)) {
    for (const s of answer.sources) {
      const c = byGuest.get(s.guest)
      if (!c || s.video_id) continue
      const t = s.timestamp_start ? toSeconds(s.timestamp_start) : 0
      s.video_id = c.id
      s.youtube_url = `https://www.youtube.com/watch?v=${c.id}${t > 0 ? `&t=${t}` : ''}`
      s.episode_title = c.title
      patched++
    }
  }
  fs.writeFileSync(preFile, JSON.stringify(pre, null, 2))
  console.log(`✓ patched ${patched} source cards in lib/precomputed-answers.json`)
}

main().catch((e) => { console.error(e); process.exit(1) })
