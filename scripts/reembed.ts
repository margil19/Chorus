/**
 * Re-embedding script: fills in halfvec(1024) embeddings for any chunks
 * whose embedding column is NULL (e.g. after a VACUUM FULL wiped the column).
 *
 * Safe to run multiple times — only touches rows where embedding IS NULL.
 *
 * Usage:
 *   npx tsx scripts/reembed.ts              # embed all missing
 *   npx tsx scripts/reembed.ts --dry-run    # count missing, exit
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_MODEL = 'voyage-3-large'

/** Texts per Voyage AI request. Max 128; 50 keeps us comfortably under token limits. */
const EMBED_BATCH_SIZE = 50

/** Concurrent Supabase UPDATE calls fired after each embedding batch. */
const UPDATE_CONCURRENCY = 10

/** Rows fetched per Supabase SELECT page. */
const PAGE_SIZE = 1000

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ChunkRow {
  id: string
  text: string
}

/** Paginate through all chunks where embedding IS NULL. */
async function fetchUnembedded(): Promise<ChunkRow[]> {
  const rows: ChunkRow[] = []
  let from = 0

  for (;;) {
    const { data, error } = await supabase
      .from('chunks')
      .select('id, text')
      .is('embedding', null)
      .range(from, from + PAGE_SIZE - 1)
      // Stable ordering so pagination doesn't shift under us
      .order('id', { ascending: true })

    if (error) throw new Error(`Supabase SELECT failed: ${error.message}`)
    if (!data || data.length === 0) break

    rows.push(...(data as ChunkRow[]))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return rows
}

/** Call Voyage AI and return embeddings in the same order as `texts`. */
async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: texts }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Voyage API ${res.status}: ${body}`)
  }

  const json = (await res.json()) as {
    data: { embedding: number[]; index: number }[]
  }

  return json.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding)
}

/**
 * Write one embedding back to Supabase.
 *
 * The embedding is formatted as a pgvector text literal "[v1,v2,…]".
 * This is the canonical text input format for both vector and halfvec —
 * Postgres casts it to halfvec(1024) automatically based on the column type.
 */
async function writeEmbedding(id: string, embedding: number[]): Promise<void> {
  const literal = `[${embedding.join(',')}]`

  const { error } = await supabase
    .from('chunks')
    .update({ embedding: literal })
    .eq('id', id)

  if (error) throw new Error(`UPDATE failed for chunk ${id}: ${error.message}`)
}

/** Format seconds as m:ss */
function fmtEta(secs: number): string {
  if (!isFinite(secs)) return '?'
  const m = Math.floor(secs / 60)
  const s = Math.round(secs % 60)
  return m > 0 ? `${m}m${s}s` : `${s}s`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  process.stdout.write('Counting chunks with missing embeddings… ')
  const rows = await fetchUnembedded()
  console.log(`${rows.length} found.\n`)

  if (rows.length === 0) {
    console.log('✓ Nothing to do — all chunks already have embeddings.')
    return
  }

  if (dryRun) {
    console.log('--dry-run: exiting without changes.')
    return
  }

  const totalBatches = Math.ceil(rows.length / EMBED_BATCH_SIZE)
  let done = 0
  let failed = 0
  const failedIds: string[] = []
  const startMs = Date.now()

  for (let b = 0; b < totalBatches; b++) {
    const batch = rows.slice(b * EMBED_BATCH_SIZE, (b + 1) * EMBED_BATCH_SIZE)

    try {
      // 1. Embed the batch in one Voyage request
      const embeddings = await embedBatch(batch.map((r) => r.text))

      // 2. Write back in parallel, capped to UPDATE_CONCURRENCY
      for (let k = 0; k < batch.length; k += UPDATE_CONCURRENCY) {
        const group = batch.slice(k, k + UPDATE_CONCURRENCY)
        await Promise.all(
          group.map((chunk, j) =>
            writeEmbedding(chunk.id, embeddings[k + j]).catch((err) => {
              // Collect per-row failures without aborting the whole batch
              failedIds.push(chunk.id)
              throw err
            })
          )
        )
      }

      done += batch.length
    } catch {
      // Batch-level failure: mark all remaining rows in this batch as failed
      const alreadyFailed = failedIds.length
      const newFails = batch.length - (done - (rows.length - (totalBatches - b) * EMBED_BATCH_SIZE))
      failed += Math.max(newFails, batch.length - (done % EMBED_BATCH_SIZE || batch.length))
      void alreadyFailed // suppress unused warning
    }

    // Progress line
    const elapsedS = (Date.now() - startMs) / 1000
    const rate = done / Math.max(elapsedS, 0.1)
    const eta = fmtEta((rows.length - done - failed) / rate)
    process.stdout.write(
      `\r  [${b + 1}/${totalBatches}]  ${done.toLocaleString()} embedded` +
        `  ·  ${failed} failed` +
        `  ·  ETA ${eta}          `
    )
  }

  console.log('\n')

  if (failed === 0) {
    console.log(`✓ All ${done.toLocaleString()} chunks embedded successfully.`)
  } else {
    console.log(`Done.  ✓ ${done.toLocaleString()} embedded  ✗ ${failed} failed`)
    if (failedIds.length > 0) {
      console.log(`\nFirst few failed IDs:`)
      failedIds.slice(0, 5).forEach((id) => console.log(`  ${id}`))
      console.log('Re-run to retry — the script only processes NULL rows.')
    }
  }
}

main().catch((err) => {
  console.error('\n', err)
  process.exit(1)
})
