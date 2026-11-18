import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import precomputedAnswers from '@/lib/precomputed-answers.json'
import { answerQuestion, replayAnswer, type AnswerEvent, type AskApiResponse } from '@/lib/answer'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── SSE helper ────────────────────────────────────────────────────────────────

type Enqueue = (event: string, data: unknown) => void

function sseResponse(fn: (enqueue: Enqueue) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue: Enqueue = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      try {
        await fn(enqueue)
      } catch (err) {
        console.error('[ask] error:', err)
        enqueue('error', { message: 'Something went wrong while answering. Please try again.' })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  })
}

// ── In-memory response cache (FIFO, max 100 entries, per instance) ────────────

const responseCache = new Map<string, AskApiResponse>()

const isComplete = (a: AskApiResponse) => a.sections.length > 0 && a.bottom_line !== ''

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { question: rawQuestion, fresh } = (await req.json()) as { question?: string; fresh?: boolean }
  const question = rawQuestion?.trim()
  if (!question) return Response.json({ error: 'question is required' }, { status: 400 })

  // `fresh` lets scripts/precompute-answers.ts regenerate stored answers locally.
  const bypassStored = fresh === true && process.env.NODE_ENV !== 'production'
  const stored = bypassStored
    ? undefined
    : ((precomputedAnswers as Record<string, unknown>)[question] as AskApiResponse | undefined) ??
      responseCache.get(question.toLowerCase())
  if (stored) {
    return sseResponse(async (enqueue) => {
      replayAnswer(stored, (e: AnswerEvent) => enqueue(e.event, e.data))
      enqueue('done', stored)
    })
  }

  return sseResponse(async (enqueue) => {
    const t0 = Date.now()
    const log = (label: string) => console.log(`[ask] ${label}: ${Date.now() - t0}ms`)

    const response = await answerQuestion(supabase, anthropic, question, (e) => enqueue(e.event, e.data), log)
    if (!response) {
      enqueue('error', { message: 'No relevant content found. Try a different question.' })
      return
    }
    if (!isComplete(response)) {
      console.error('[ask] incomplete synthesis', { question, sections: response.sections.length })
      enqueue('error', { message: "Couldn't put together a full answer. Please try again." })
      return
    }

    responseCache.set(question.toLowerCase(), response)
    if (responseCache.size > 100) responseCache.delete(responseCache.keys().next().value!)

    enqueue('done', response)
    log('total')
  })
}
