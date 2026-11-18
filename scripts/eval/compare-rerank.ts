/**
 * Is the gain from reranking or from keyword candidates? Blind comparison, full corpus:
 *   B  v2 vector only
 *   D  v2 hybrid + rerank-2.5
 *   E  v2 vector + rerank-2.5
 *   G  v2 vector + rerank-2.5, no per-guest cap for people the question names
 *
 *   npx tsx scripts/eval/compare-rerank.ts [--questions scripts/eval/questions-named.json]
 */
import Anthropic from '@anthropic-ai/sdk'
import { supabase, questions, voyageEmbed } from './common'
import { searchChunks, rerank, diversify, peopleNamedIn, type RetrievedChunk } from '../../lib/retrieval'

const K = 5
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const SYSTEMS = ['B', 'D', 'E', 'G'] as const
type Sys = (typeof SYSTEMS)[number]
type Hit = { sys: Sys; guest: string; text: string }

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

const timed = async <T>(acc: Record<string, number>, key: string, fn: () => Promise<T>): Promise<T> => {
  const t = Date.now(); const r = await fn(); acc[key] = (acc[key] ?? 0) + Date.now() - t; return r
}

async function main() {
  const emb = await voyageEmbed(questions, 'query')
  const totals = Object.fromEntries(SYSTEMS.map((s) => [s, { sum: 0, strong: 0, junk: 0 }])) as Record<Sys, { sum: number; strong: number; junk: number }>
  const ms: Record<string, number> = {}

  for (const [i, q] of questions.entries()) {
    // Stop words only → the function's keyword side is empty, so this is pure vector search.
    const vec = await timed(ms, 'vector search', () => searchChunks(supabase, emb[i], null, 40))
    const hyb = await timed(ms, 'hybrid search', () => searchChunks(supabase, emb[i], q, 40))
    const d = await timed(ms, 'rerank-2.5', () => rerank(q, hyb))
    const e = await rerank(q, vec)
    const pick = (sys: Sys, xs: RetrievedChunk[], uncapped?: Set<string>): Hit[] =>
      diversify(xs, K, 2, uncapped).map((c) => ({ sys, guest: c.guest, text: c.text }))
    const all = [...pick('B', vec), ...pick('D', d), ...pick('E', e), ...pick('G', e, peopleNamedIn(q, vec))]
    const order = all.map((_, j) => j).sort(() => Math.random() - 0.5)
    const scores = await judge(q, order.map((j) => all[j]))
    const byS = { B: 0, D: 0, E: 0, G: 0 }
    order.forEach((j, k) => {
      const h = all[j], s = scores[k]
      byS[h.sys] += s; totals[h.sys].sum += s
      if (s === 2) totals[h.sys].strong++
      if (s === 0) totals[h.sys].junk++
    })
    console.log(`${String(i + 1).padStart(2)}. B ${byS.B}  D ${byS.D}  E ${byS.E}  G ${byS.G}  ${q}`)
  }

  const n = questions.length * K
  const label: Record<Sys, string> = { B: 'vector only', D: 'hybrid + rerank-2.5', E: 'vector + rerank-2.5', G: 'E + named-guest uncap' }
  console.log('')
  for (const s of SYSTEMS) {
    const x = totals[s]
    console.log(`${s} ${label[s].padEnd(22)} mean ${(x.sum / n).toFixed(2)}/2  strong ${(x.strong / n * 100).toFixed(0)}%  off-topic ${(x.junk / n * 100).toFixed(0)}%`)
  }
  console.log('\navg latency: ' + Object.entries(ms).map(([k, v]) => `${k} ${Math.round(v / questions.length)}ms`).join(', '))
}

main().catch((e) => { console.error(e); process.exit(1) })
