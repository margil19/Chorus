/**
 * Blind comparison of retrieval pipelines on the full corpus (top K per system):
 *   A  production today: `chunks` + match_chunks, one chunk per guest
 *   B  chunks_v2, vector only
 *   C  chunks_v2, hybrid (vector + full-text, RRF)
 *   D  chunks_v2, hybrid + Voyage rerank-2.5
 * B–D use the same diversity rule (≤2 per person, 1 per answer segment).
 *
 *   npx tsx scripts/eval/compare-search.ts
 */
import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { supabase, questions, voyageEmbed, EVAL_DIR } from './common'
import { searchChunks, rerank, diversify, type RetrievedChunk } from '../../lib/retrieval'

const K = 5
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
type Sys = 'A' | 'B' | 'C' | 'D'
const SYSTEMS: Sys[] = ['A', 'B', 'C', 'D']
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

async function main() {
  const { data: eps } = await supabase.from('episodes').select('id')
  const allEpisodeIds = (eps as { id: string }[]).map((e) => e.id)
  const oldEmb = await voyageEmbed(questions)
  const newEmb = await voyageEmbed(questions, 'query')

  const totals = Object.fromEntries(SYSTEMS.map((s) => [s, { sum: 0, strong: 0, junk: 0, guests: 0 }]))
  const timing = { search: 0, rerank: 0 }
  const perQ: string[] = []
  const dump: unknown[] = []

  for (const [i, q] of questions.entries()) {
    const { data: oldRows, error: oErr } = await supabase.rpc('match_chunks', { query_embedding: oldEmb[i], query_text: q, match_count: 10 })
    if (oErr) throw new Error(oErr.message)
    const seen = new Set<string>()
    const a: Hit[] = []
    for (const c of oldRows as { guest: string; text: string }[]) {
      if (seen.has(c.guest)) continue
      seen.add(c.guest); a.push({ sys: 'A', guest: c.guest, text: c.text })
      if (a.length === K) break
    }

    const { data: vecRows, error: vErr } = await supabase.rpc('eval_match_chunks_v2', { query_embedding: newEmb[i], episode_ids: allEpisodeIds, match_count: 40 })
    if (vErr) throw new Error(vErr.message)
    const b = diversify(vecRows as RetrievedChunk[], K).map((c) => ({ sys: 'B' as const, guest: c.guest, text: c.text }))

    let t = Date.now()
    const candidates = await searchChunks(supabase, newEmb[i], q, 40)
    timing.search += Date.now() - t
    const c = diversify(candidates, K).map((x) => ({ sys: 'C' as const, guest: x.guest, text: x.text }))
    t = Date.now()
    const reranked = await rerank(q, candidates)
    timing.rerank += Date.now() - t
    const d = diversify(reranked, K).map((x) => ({ sys: 'D' as const, guest: x.guest, text: x.text }))

    const textOnly = candidates.filter((x) => x.vector_rank === null).length
    const all = [...a, ...b, ...c, ...d]
    const order = all.map((_, j) => j).sort(() => Math.random() - 0.5)
    const scores = await judge(q, order.map((j) => all[j]))
    const byS: Record<Sys, number> = { A: 0, B: 0, C: 0, D: 0 }
    order.forEach((j, k) => {
      const h = all[j], s = scores[k]
      byS[h.sys] += s
      totals[h.sys].sum += s
      if (s === 2) totals[h.sys].strong++
      if (s === 0) totals[h.sys].junk++
    })
    for (const [s, hits] of [['A', a], ['B', b], ['C', c], ['D', d]] as const) totals[s].guests += new Set(hits.map((h) => h.guest)).size
    perQ.push(`${String(i + 1).padStart(2)}. A ${byS.A}  B ${byS.B}  C ${byS.C}  D ${byS.D}   (keyword-only candidates: ${textOnly})  ${q}`)
    console.log(perQ[perQ.length - 1])
    dump.push({ question: q, scored: order.map((j, k) => ({ ...all[j], score: scores[k] })) })
  }

  const n = questions.length * K
  const label: Record<Sys, string> = { A: 'production today', B: 'v2 vector only', C: 'v2 hybrid', D: 'v2 hybrid + rerank' }
  console.log('')
  for (const s of SYSTEMS) {
    const x = totals[s]
    console.log(`${s} ${label[s].padEnd(20)} mean ${(x.sum / n).toFixed(2)}/2  strong ${(x.strong / n * 100).toFixed(0)}%  off-topic ${(x.junk / n * 100).toFixed(0)}%  guests in top ${K}: ${(x.guests / questions.length).toFixed(1)}`)
  }
  console.log(`\navg latency: hybrid search ${Math.round(timing.search / questions.length)}ms, rerank ${Math.round(timing.rerank / questions.length)}ms`)
  fs.writeFileSync(path.join(EVAL_DIR, 'last-run-search.json'), JSON.stringify(dump, null, 2) + '\n')
}

main().catch((e) => { console.error(e); process.exit(1) })
