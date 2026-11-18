/**
 * Read-only audit of the transcript folder vs the episodes table:
 * duplicate transcript bodies, shared video_ids (resolved via YouTube oEmbed titles),
 * and which folders were never ingested. Writes scripts/eval/transcript-audit.json.
 *
 *   npx tsx scripts/eval/audit-transcripts.ts
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import matter from 'gray-matter'
import { supabase, TRANSCRIPTS_DIR } from '../lib/db'
import { EVAL_DIR } from './common'

interface Folder { slug: string; guest: string; title: string; video_id: string; bodyHash: string; sh: Set<string> }

const norm = (s: string) => s.replace(/\(\d{2}:\d{2}(?::\d{2})?\)/g, '').replace(/\s+/g, ' ').trim()

async function youtubeTitle(videoId: string): Promise<string | null> {
  const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`)
  if (!res.ok) return null
  return ((await res.json()) as { title: string }).title
}

const nameTokens = (guest: string) =>
  guest.toLowerCase().replace(/\b(dr|2\.0|3\.0|4\.0|live)\b/g, ' ').replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2)
/** Share of the guest's name tokens that appear in the YouTube title (titles end "| Guest Name (Company)"). */
const nameMatch = (ytTitle: string, guest: string) => {
  const t = ytTitle.toLowerCase()
  const n = nameTokens(guest)
  return n.length ? n.filter((w) => t.includes(w)).length / n.length : 0
}

/** 8-word shingles, sampled by content hash (not position) so an edited intro doesn't shift the sample. */
function shingles(text: string): Set<string> {
  const w = text.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i + 8 <= w.length; i++) {
    const s = w.slice(i, i + 8).join(' ')
    if (crypto.createHash('md5').update(s).digest()[0] < 16) out.add(s)
  }
  return out
}
const jaccard = (a: Set<string>, b: Set<string>) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n) }

async function main() {
  const folders: Folder[] = []
  for (const slug of fs.readdirSync(TRANSCRIPTS_DIR).sort()) {
    const file = path.join(TRANSCRIPTS_DIR, slug, 'transcript.md')
    if (!fs.existsSync(file)) continue
    const { data, content } = matter(fs.readFileSync(file, 'utf8'))
    const body = norm(content)
    // Skip the intro, which can differ between re-uploads of the same conversation.
    folders.push({
      slug, guest: data.guest, title: data.title, video_id: (data.video_id as string | undefined) || '',
      bodyHash: crypto.createHash('md5').update(body.slice(Math.min(5000, Math.floor(body.length / 4)))).digest('hex'),
      sh: shingles(body),
    })
  }
  // Same conversation re-uploaded with small edits: >50% shared 8-word shingles.
  const nearDup = new Map<string, string>()
  for (let i = 0; i < folders.length; i++)
    for (let j = 0; j < i; j++)
      if (!nearDup.has(folders[i].slug) && jaccard(folders[i].sh, folders[j].sh) > 0.5) nearDup.set(folders[i].slug, folders[j].slug)

  const { data: eps, error } = await supabase.from('episodes').select('id, guest, title, video_id')
  if (error) throw new Error(error.message)
  const epByVideo = new Map((eps as { id: string; guest: string; title: string; video_id: string }[]).map((e) => [e.video_id, e]))

  const firstByHash = new Map<string, Folder>()
  const firstByVideo = new Map<string, Folder>()
  // ingest.ts keyed on (video_id || slug), first folder in sorted order wins.
  const ingestKey = (f: Folder) => f.video_id || f.slug
  const firstByKey = new Map<string, Folder>()
  const result = folders.map((f) => {
    const dupOf = firstByHash.get(f.bodyHash)
    if (!dupOf) firstByHash.set(f.bodyHash, f)
    const takenBy = firstByKey.get(ingestKey(f)) ?? null
    if (!takenBy) firstByKey.set(ingestKey(f), f)
    const ingestedAs = takenBy ? null : epByVideo.get(ingestKey(f)) ?? null
    const { sh: _sh, ...rest } = f
    return {
      ...rest,
      duplicateOf: dupOf?.slug ?? nearDup.get(f.slug) ?? null,
      ingestedEpisodeId: ingestedAs?.id ?? null,
      videoIdSharedWith: takenBy?.slug ?? null,
    }
  })

  // Ask YouTube which guest each contested video really belongs to.
  const contested = [...new Set(result.filter((r) => r.videoIdSharedWith && r.video_id).map((r) => r.video_id))]
  const owner: Record<string, { youtubeTitle: string | null; ownerSlug: string | null }> = {}
  for (const vid of contested) {
    const yt = await youtubeTitle(vid)
    const claimants = result.filter((r) => r.video_id === vid)
    const scored = yt ? claimants.map((c) => ({ c, s: nameMatch(yt, c.guest) })).sort((a, b) => b.s - a.s) : []
    const clear = scored.length && scored[0].s >= 0.5 && (scored.length < 2 || scored[0].s > scored[1].s || scored[0].c.duplicateOf === null)
    owner[vid] = { youtubeTitle: yt, ownerSlug: clear ? scored[0].c.slug : null }
  }

  const rows = result.map((r) => ({
    ...r,
    videoOwner: !r.video_id ? null : owner[r.video_id] ? owner[r.video_id].ownerSlug : r.slug,
    youtubeTitle: owner[r.video_id]?.youtubeTitle ?? null,
  }))
  fs.writeFileSync(path.join(EVAL_DIR, 'transcript-audit.json'), JSON.stringify(rows, null, 2) + '\n')

  const dups = rows.filter((r) => r.duplicateOf)
  const missing = rows.filter((r) => !r.ingestedEpisodeId)
  const missingUnique = missing.filter((r) => !r.duplicateOf)
  console.log(`folders ${rows.length}, ingested ${rows.length - missing.length}, not ingested ${missing.length} (${missingUnique.length} unique, ${missing.length - missingUnique.length} duplicate content)`)
  console.log(`\nDUPLICATE CONTENT (same transcript body as an earlier folder):`)
  for (const r of dups) console.log(`  ${r.slug} (${r.guest}) == ${r.duplicateOf}   ${r.ingestedEpisodeId ? '[in DB]' : '[not in DB]'}`)
  console.log(`\nNOT INGESTED, UNIQUE CONTENT (to add):`)
  for (const r of missingUnique) console.log(`  ${r.slug} (${r.guest})  video: ${r.videoOwner === r.slug ? r.video_id : 'none known'}`)
  console.log(`\nIN DB WITH SOMEONE ELSE'S VIDEO (live clip links wrong):`)
  for (const r of rows.filter((x) => x.ingestedEpisodeId && x.video_id && x.videoOwner !== x.slug)) {
    console.log(`  ${r.slug} (${r.guest}) has ${r.video_id} = "${r.youtubeTitle?.slice(0, 60)}"  → belongs to ${r.videoOwner ?? 'unclear'}`)
  }
  const unclear = contested.filter((v) => !owner[v].ownerSlug)
  if (unclear.length) console.log(`\nUNRESOLVED: ${unclear.map((v) => `${v} "${owner[v].youtubeTitle?.slice(0, 50)}"`).join('; ')}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
