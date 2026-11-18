import type { SupabaseClient } from '@supabase/supabase-js'
import { parseTranscript, buildWindowChunks, embeddingText } from './transcript'
import { voyageEmbed } from './voyage'

const EMBED_BATCH_SIZE = 64
const INSERT_BATCH_SIZE = 200

/** Splits a transcript into answer windows without embedding them (for dry runs). */
export function previewEpisodeChunks(ep: { guest: string; title: string }, content: string) {
  const windows = buildWindowChunks(parseTranscript(content))
  return { windows, texts: windows.map((w) => embeddingText(ep.guest, ep.title, w)) }
}

/** Replaces an episode's chunks_v2 rows with freshly built and embedded windows. Returns the count. */
export async function writeEpisodeChunks(
  supabase: SupabaseClient,
  ep: { id: string; guest: string; title: string },
  content: string
): Promise<number> {
  const { windows, texts } = previewEpisodeChunks(ep, content)

  const embeddings: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    embeddings.push(...(await voyageEmbed(texts.slice(i, i + EMBED_BATCH_SIZE), 'document')))
  }

  const { error: delErr } = await supabase.from('chunks_v2').delete().eq('episode_id', ep.id)
  if (delErr) throw new Error(`chunks_v2 delete failed: ${delErr.message}`)

  const rows = windows.map((w, i) => ({
    episode_id: ep.id,
    speaker: w.speaker,
    timestamp_start: w.timestamp_start,
    question: w.question,
    segment_index: w.segment_index,
    window_index: w.window_index,
    text: w.text,
    // pgvector text literal; Postgres casts it to halfvec(1024) from the column type.
    embedding: `[${embeddings[i].join(',')}]`,
  }))
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const { error } = await supabase.from('chunks_v2').insert(rows.slice(i, i + INSERT_BATCH_SIZE))
    if (error) throw new Error(`chunks_v2 insert failed: ${error.message}`)
  }
  return rows.length
}
