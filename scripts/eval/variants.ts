/**
 * In-memory chunking experiments on the pilot episodes, judged blind against the
 * old `chunks` table. Nothing is written to Supabase.
 *
 *   npx tsx scripts/eval/variants.ts
 */
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import Anthropic from '@anthropic-ai/sdk'
import { parseTranscript, buildWindowChunks, embeddingText, type QuestionMode, type WindowChunk } from '../lib/transcript'
import { supabase, questions, voyageEmbed, transcriptDirsByVideoId, EVAL_DIR, voyageTokens } from './common'

const K = 5
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const VARIANTS: { name: string; questionMode: QuestionMode; minWords: number }[] = [
  { name: 'B: question on first window, min 50 words', questionMode: 'first', minWords: 50 },
  { name: 'C: no question, min 50 words', questionMode: 'none', minWords: 50 },
]

type Hit = { guest: string; text: string }

async function judge(question: string, passages: Hit[], attempt = 1): Promise<number[]> {
  const list = passages.map((p, i) => `[${i}] (${p.guest}) ${p.text.slice(0, 1600)}`).join('\n\n')
  const msg = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: `You are grading search results for a podcast Q&A product. For each passage, score how useful it is for answering the question:
2 = directly addresses the question with substantive advice or insight
1 = related, partially useful
0 = off-topic, filler, or too thin to use

Question: "${question}"

Passages:
${list}

Return only JSON mapping every passage number to its score, e.g. {"0":2,"1":0,...,"${passages.length - 1}":1}`,
    }],
  })
  const raw = msg.content.find((b) => b.type === 'text')?.text ?? ''
  const json = raw.match(/\{[\s\S]*\}/)
  const byIndex = json ? (JSON.parse(json[0]) as Record<string, number>) : {}
  const scores = passages.map((_, i) => byIndex[String(i)])
  if (scores.some((s) => typeof s !== 'number')) {
    if (attempt < 3) return judge(question, passages, attempt + 1)
    throw new Error('judge failed')
  }
  return scores
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / Math.sqrt(na * nb)
}

async function main() {
  const pilot = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'pilot-episodes.json'), 'utf8')) as { id: string; video_id: string }[]
  const { data: eps } = await supabase.from('episodes').select('id, guest, title, video_id').in('id', pilot.map((p) => p.id))
  const dirs = transcriptDirsByVideoId()
  const turnsByEp = (eps as { id: string; guest: string; title: string; video_id: string }[]).map((e) => ({
    ...e,
    turns: parseTranscript(matter(fs.readFileSync(path.join(dirs.get(e.video_id)!, 'transcript.md'), 'utf8')).content),
  }))

  const oldEmb = await voyageEmbed(questions)
  const qEmb = await voyageEmbed(questions, 'query')
  const oldHits: Hit[][] = []
  for (const [i, q] of questions.entries()) {
    const { data, error } = await supabase.rpc('eval_match_chunks_v1', { query_embedding: oldEmb[i], query_text: q, episode_ids: pilot.map((p) => p.id), match_count: K })
    if (error) throw new Error(error.message)
    oldHits.push(data as Hit[])
  }

  for (const v of VARIANTS) {
    const items: { guest: string; chunk: WindowChunk; text: string }[] = []
    for (const e of turnsByEp) for (const c of buildWindowChunks(e.turns, v.minWords)) items.push({ guest: e.guest, chunk: c, text: embeddingText(e.guest, e.title, c, v.questionMode) })
    const embs: number[][] = []
    for (let i = 0; i < items.length; i += 64) embs.push(...(await voyageEmbed(items.slice(i, i + 64).map((x) => x.text), 'document')))

    let oldSum = 0, newSum = 0, oldStrong = 0, newStrong = 0, oldJunk = 0, newJunk = 0, wins = 0, losses = 0
    const perQ: string[] = []
    for (const [qi, q] of questions.entries()) {
      const ranked = items.map((x, j) => ({ x, s: cosine(qEmb[qi], embs[j]) })).sort((a, b) => b.s - a.s).slice(0, K)
      const newHits: Hit[] = ranked.map((r) => ({ guest: r.x.guest, text: r.x.chunk.text }))
      const all = [...oldHits[qi].map((h) => ({ ...h, sys: 'old' })), ...newHits.map((h) => ({ ...h, sys: 'new' }))]
      const order = all.map((_, j) => j).sort(() => Math.random() - 0.5)
      const scores = await judge(q, order.map((j) => all[j]))
      let o = 0, n = 0
      order.forEach((j, k) => {
        const s = scores[k]
        if (all[j].sys === 'old') { o += s; if (s === 2) oldStrong++; if (s === 0) oldJunk++ }
        else { n += s; if (s === 2) newStrong++; if (s === 0) newJunk++ }
      })
      oldSum += o; newSum += n
      if (n > o) wins++; else if (n < o) losses++
      perQ.push(`${String(qi + 1).padStart(2)}. old ${o}  new ${n}`)
    }
    const total = questions.length * K
    console.log(`\n=== ${v.name}  (${items.length} chunks)`)
    console.log(perQ.join('   ').replace(/(.{0,150})\s{3}/g, '$1\n'))
    console.log(`OLD mean ${(oldSum / total).toFixed(2)}  strong ${(oldStrong / total * 100).toFixed(0)}%  off-topic ${(oldJunk / total * 100).toFixed(0)}%`)
    console.log(`NEW mean ${(newSum / total).toFixed(2)}  strong ${(newStrong / total * 100).toFixed(0)}%  off-topic ${(newJunk / total * 100).toFixed(0)}%`)
    console.log(`new better ${wins}, worse ${losses}, tied ${questions.length - wins - losses}`)
  }
  console.log(`\nVoyage tokens: ${voyageTokens}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
