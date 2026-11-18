/**
 * Picks the pilot episodes for chunks_v2: the episodes that current production
 * retrieval surfaces most for the test questions, padded up to --count.
 *
 *   npx tsx scripts/eval/pick-episodes.ts --count 50
 */
import fs from 'fs'
import path from 'path'
import { supabase, questions, voyageEmbed, transcriptDirsByVideoId, EVAL_DIR } from './common'

async function main() {
  const countIdx = process.argv.indexOf('--count')
  const count = countIdx >= 0 ? parseInt(process.argv[countIdx + 1], 10) : 50

  const hits = new Map<string, number>()
  const embeddings = await voyageEmbed(questions)
  for (let i = 0; i < questions.length; i++) {
    const { data, error } = await supabase.rpc('match_chunks', {
      query_embedding: embeddings[i],
      query_text: questions[i],
      match_count: 20,
    })
    if (error) throw new Error(error.message)
    for (const c of data as { episode_id: string }[]) hits.set(c.episode_id, (hits.get(c.episode_id) ?? 0) + 1)
  }

  const { data: episodes, error } = await supabase.from('episodes').select('id, guest, video_id').order('id')
  if (error) throw new Error(error.message)
  const dirs = transcriptDirsByVideoId()
  const withTranscript = (episodes as { id: string; guest: string; video_id: string }[]).filter((e) => dirs.has(e.video_id))

  const ranked = [...withTranscript].sort((a, b) => (hits.get(b.id) ?? 0) - (hits.get(a.id) ?? 0))
  const picked = ranked.slice(0, count)

  fs.writeFileSync(
    path.join(EVAL_DIR, 'pilot-episodes.json'),
    JSON.stringify(picked.map((e) => ({ id: e.id, guest: e.guest, video_id: e.video_id })), null, 2) + '\n'
  )
  const fromHits = picked.filter((e) => hits.has(e.id)).length
  console.log(`Picked ${picked.length} episodes (${fromHits} surfaced by the test questions, ${picked.length - fromHits} padding).`)
  console.log(`Episodes in DB: ${episodes.length}, with local transcript: ${withTranscript.length}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
