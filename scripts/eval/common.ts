import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

export const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export const TRANSCRIPTS_DIR =
  process.env.TRANSCRIPTS_DIR ?? '/Users/margilgandhi/projects/lennys-podcast-transcripts/episodes'

export const EVAL_DIR = path.resolve(process.cwd(), 'scripts/eval')

export const questions: string[] = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'questions.json'), 'utf8'))

export async function voyageEmbed(texts: string[], inputType?: 'query' | 'document'): Promise<number[][]> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'voyage-3-large', input: texts, ...(inputType && { input_type: inputType }) }),
  })
  if (!res.ok) throw new Error(`Voyage API ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { data: { embedding: number[]; index: number }[]; usage: { total_tokens: number } }
  voyageTokens += json.usage.total_tokens
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}
export let voyageTokens = 0

/**
 * Maps episode video_id → transcript directory the way ingest.ts resolved it:
 * folders in sorted order, first one wins. Some folders share a video_id; ingest
 * skipped the later ones as "already ingested".
 */
export function transcriptDirsByVideoId(): Map<string, string> {
  const map = new Map<string, string>()
  for (const slug of fs.readdirSync(TRANSCRIPTS_DIR).sort()) {
    const file = path.join(TRANSCRIPTS_DIR, slug, 'transcript.md')
    if (!fs.existsSync(file)) continue
    const { data } = matter(fs.readFileSync(file, 'utf8'))
    const videoId = (data.video_id as string | undefined) ?? slug
    if (!map.has(videoId)) map.set(videoId, path.join(TRANSCRIPTS_DIR, slug))
  }
  return map
}
