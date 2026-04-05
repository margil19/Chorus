/**
 * Pre-computes /api/ask answers for a fixed set of questions and writes the
 * results to lib/precomputed-answers.json.
 *
 * Usage:
 *   npm run precompute          (server must be running at localhost:3000)
 *
 * Existing entries are loaded first — only missing questions are fetched.
 */

import fs from 'fs'
import path from 'path'

// ── Questions ─────────────────────────────────────────────────────────────────

const QUESTIONS = [
  'How do the best PMs think about prioritization?',
  'What frameworks do top PMs use to say no?',
  'How do you prioritize when everything feels urgent?',
  'How should early-stage startups approach growth?',
  'What separates organic growth from paid growth?',
  'When should a startup hire their first growth person?',
  'What does good product strategy actually look like?',
  'How do you know when you\'ve found product-market fit?',
  'How do the best PMs think about building a roadmap?',
  'How do you build a culture of high ownership?',
  'What separates great product leaders from good ones?',
  'How do you hire a great PM?',
  'What\'s the right way to run a product review?',
  'How do you influence without authority as a PM?',
  'When should you listen to users vs. ignore them?',
  'How should a first-time founder think about their MVP?',
  'What are the biggest mistakes PMs make at 0 to 1?',
  'How do you validate an idea before building it?',
]

// ── Paths ─────────────────────────────────────────────────────────────────────

const LIB_DIR = path.resolve(process.cwd(), 'lib')
const OUTPUT_PATH = path.join(LIB_DIR, 'precomputed-answers.json')
const API_URL = 'http://localhost:3000/api/ask'
const DELAY_MS = 500

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function loadExisting(): Record<string, unknown> {
  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      const raw = fs.readFileSync(OUTPUT_PATH, 'utf-8')
      return JSON.parse(raw) as Record<string, unknown>
    } catch (err) {
      console.warn('⚠️  Could not parse existing file — starting fresh:', (err as Error).message)
    }
  }
  return {}
}

async function fetchAnswer(question: string): Promise<unknown> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, skipRewrite: true }),
  })

  const data = (await res.json()) as Record<string, unknown>

  if (!res.ok) {
    throw new Error(String(data.error ?? `HTTP ${res.status}`))
  }

  return data
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Ensure lib/ directory exists
  if (!fs.existsSync(LIB_DIR)) {
    fs.mkdirSync(LIB_DIR, { recursive: true })
    console.log(`📁 Created ${LIB_DIR}`)
  }

  const answers = loadExisting()
  const total = QUESTIONS.length
  const pending = QUESTIONS.filter((q) => !(q in answers))

  console.log(`\n🧠  Pre-computing answers`)
  console.log(`   Total questions : ${total}`)
  console.log(`   Already cached  : ${total - pending.length}`)
  console.log(`   To fetch        : ${pending.length}\n`)

  if (pending.length === 0) {
    console.log('✅  All questions already computed. Nothing to do.')
    return
  }

  let done = total - pending.length

  for (const question of pending) {
    done++
    const label = `${done}/${total}`
    const preview = question.length > 55 ? question.slice(0, 52) + '…' : question

    try {
      process.stdout.write(`  ⏳ [${label}] ${preview} … `)
      const answer = await fetchAnswer(question)
      answers[question] = answer
      console.log('✓')

      // Persist after each successful fetch so progress survives interrupts
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(answers, null, 2), 'utf-8')
    } catch (err) {
      console.log(`✗  ERROR: ${(err as Error).message}`)
    }

    if (done < total) {
      await sleep(DELAY_MS)
    }
  }

  const computed = Object.keys(answers).length
  console.log(`\n✅  Done. ${computed}/${total} answers saved to ${OUTPUT_PATH}\n`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
