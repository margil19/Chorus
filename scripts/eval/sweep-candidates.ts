/**
 * How many vector candidates should go to the reranker? Runs the live pipeline
 * (vector search → rerank-2.5 → diversify with named-guest uncap) at each pool size,
 * keeps the top 5, and grades all of them blind together.
 *
 *   npx tsx scripts/eval/sweep-candidates.ts --k 20,40 [--questions scripts/eval/questions-named.json]
 */
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../lib/db'
import { voyageEmbed } from '../lib/voyage'
import { questions } from './common'
import { searchChunks, rerank, diversify, peopleNamedIn, type RetrievedChunk } from '../../lib/retrieval'

const KEEP = 5
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const kIdx = process.argv.indexOf('--k')
const POOLS = (kIdx >= 0 ? process.argv[kIdx + 1] : '20,40').split(',').map(Number)

type Hit = { pool: number; chunk_id: string; guest: string; text: string }

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
  const maxPool = Math.max(...POOLS)
  const emb = await voyageEmbed(questions, 'query')
  const totals = new Map(POOLS.map((k) => [k, { sum: 0, strong: 0, junk: 0, rerankMs: 0 }]))
  let identical = 0

  for (const [i, q] of questions.entries()) {
    // Vector-only results are ordered by distance, so the top k of one big search
    // is exactly what a search for k would return.
    const candidates = await searchChunks(supabase, emb[i], null, maxPool)
    const named = peopleNamedIn(q, candidates)
    const picks = new Map<number, RetrievedChunk[]>()
    for (const k of POOLS) {
      const t = Date.now()
      const reranked = await rerank(q, candidates.slice(0, k))
      totals.get(k)!.rerankMs += Date.now() - t
      picks.set(k, diversify(reranked, KEEP, 2, named))
    }

    const ids = POOLS.map((k) => picks.get(k)!.map((c) => c.chunk_id).sort().join())
    if (ids.every((x) => x === ids[0])) identical++

    // Grade each distinct passage once, so a passage both pools picked gets one score.
    const unique = new Map<string, RetrievedChunk>()
    for (const k of POOLS) for (const c of picks.get(k)!) unique.set(c.chunk_id, c)
    const passages: Hit[] = [...unique.values()]
      .map((c) => ({ pool: 0, chunk_id: c.chunk_id, guest: c.guest, text: c.text }))
      .sort(() => Math.random() - 0.5)
    const scores = await judge(q, passages)
    const scoreOf = new Map(passages.map((p, j) => [p.chunk_id, scores[j]]))

    const line = POOLS.map((k) => {
      const s = picks.get(k)!.map((c) => scoreOf.get(c.chunk_id)!)
      const t = totals.get(k)!
      t.sum += s.reduce((a, b) => a + b, 0)
      t.strong += s.filter((x) => x === 2).length
      t.junk += s.filter((x) => x === 0).length
      return `k=${k} ${s.reduce((a, b) => a + b, 0)}/${KEEP * 2}`
    }).join('  ')
    console.log(`${String(i + 1).padStart(2)}. ${line}${ids.every((x) => x === ids[0]) ? '  (same 5)' : ''}  ${q}`)
  }

  const n = questions.length * KEEP
  console.log('')
  for (const k of POOLS) {
    const t = totals.get(k)!
    console.log(`k=${String(k).padEnd(3)} mean ${(t.sum / n).toFixed(2)}/2  strong ${(t.strong / n * 100).toFixed(0)}%  off-topic ${(t.junk / n * 100).toFixed(0)}%  rerank ${Math.round(t.rerankMs / questions.length)}ms`)
  }
  console.log(`identical top ${KEEP} across pools: ${identical}/${questions.length} questions`)
}

main().catch((e) => { console.error(e); process.exit(1) })
