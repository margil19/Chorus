/**
 * Blind retrieval comparison: chunks (old) vs chunks_v2 (new), restricted to the
 * pilot episodes. Claude scores each top-K passage 0–2 without knowing its source.
 *
 *   npx tsx scripts/eval/compare.ts
 */
import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { supabase, questions, voyageEmbed, EVAL_DIR } from './common'

const K = 5
const JUDGE_CHARS = 1600
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

type Hit = { system: 'old' | 'new'; guest: string; text: string; similarity: number }

async function judge(question: string, passages: Hit[], attempt = 1): Promise<number[]> {
  const list = passages.map((p, i) => `[${i}] (${p.guest}) ${p.text.slice(0, JUDGE_CHARS)}`).join('\n\n')
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
    throw new Error(`judge failed to score all ${passages.length} passages`)
  }
  return scores
}

async function main() {
  const pilot = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'pilot-episodes.json'), 'utf8')) as { id: string }[]
  const episodeIds = pilot.map((e) => e.id)

  const oldEmb = await voyageEmbed(questions)
  const newEmb = await voyageEmbed(questions, 'query')

  const rows: { question: string; old: (Hit & { score: number })[]; new: (Hit & { score: number })[] }[] = []
  for (const [i, q] of questions.entries()) {
    const [o, n] = await Promise.all([
      supabase.rpc('eval_match_chunks_v1', { query_embedding: oldEmb[i], query_text: q, episode_ids: episodeIds, match_count: K }),
      supabase.rpc('eval_match_chunks_v2', { query_embedding: newEmb[i], episode_ids: episodeIds, match_count: K }),
    ])
    if (o.error || n.error) throw new Error((o.error ?? n.error)!.message)
    const hits: Hit[] = [
      ...(o.data as Hit[]).map((h) => ({ ...h, system: 'old' as const })),
      ...(n.data as Hit[]).map((h) => ({ ...h, system: 'new' as const })),
    ]
    const order = hits.map((_, j) => j).sort(() => Math.random() - 0.5)
    const shuffled = order.map((j) => hits[j])
    const scores = await judge(q, shuffled)
    const scored = shuffled.map((h, j) => ({ ...h, score: scores[j] }))
    rows.push({ question: q, old: scored.filter((h) => h.system === 'old'), new: scored.filter((h) => h.system === 'new') })

    const sum = (hs: { score: number }[]) => hs.reduce((s, h) => s + h.score, 0)
    console.log(`${String(i + 1).padStart(2)}. old ${sum(rows[i].old)}/${2 * K}  new ${sum(rows[i].new)}/${2 * K}  ${q}`)
  }

  const all = (sys: 'old' | 'new') => rows.flatMap((r) => r[sys])
  const report = (sys: 'old' | 'new') => {
    const hs = all(sys)
    const mean = hs.reduce((s, h) => s + h.score, 0) / hs.length
    const strong = hs.filter((h) => h.score === 2).length / hs.length
    const junk = hs.filter((h) => h.score === 0).length / hs.length
    const guests = rows.reduce((s, r) => s + new Set(r[sys].map((h) => h.guest)).size, 0) / rows.length
    return `mean ${mean.toFixed(2)}/2   strong ${(strong * 100).toFixed(0)}%   off-topic ${(junk * 100).toFixed(0)}%   unique guests in top ${K}: ${guests.toFixed(1)}`
  }
  const wins = rows.filter((r) => r.new.reduce((s, h) => s + h.score, 0) > r.old.reduce((s, h) => s + h.score, 0)).length
  const losses = rows.filter((r) => r.new.reduce((s, h) => s + h.score, 0) < r.old.reduce((s, h) => s + h.score, 0)).length

  console.log(`\nOLD  ${report('old')}\nNEW  ${report('new')}`)
  console.log(`\nNew better on ${wins}, worse on ${losses}, tied on ${rows.length - wins - losses} of ${rows.length} questions`)
  fs.writeFileSync(path.join(EVAL_DIR, 'last-run.json'), JSON.stringify(rows, null, 2) + '\n')
}

main().catch((e) => { console.error(e); process.exit(1) })
