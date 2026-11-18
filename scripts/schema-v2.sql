-- ── chunks_v2: guest answer windows (see scripts/lib/transcript.ts buildWindowChunks) ──
-- Lives alongside `chunks`; the app keeps reading `chunks` until we switch over.

CREATE TABLE IF NOT EXISTS chunks_v2 (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id      UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  speaker         TEXT NOT NULL,
  timestamp_start TEXT NOT NULL,
  question        TEXT,            -- host question that preceded this answer
  segment_index   INT  NOT NULL,   -- answer segment within the episode
  window_index    INT  NOT NULL,   -- window within the segment (siblings share segment_index)
  text            TEXT NOT NULL,
  embedding       halfvec(1024),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (episode_id, segment_index, window_index)
);

CREATE INDEX IF NOT EXISTS chunks_v2_embedding_idx
  ON chunks_v2 USING hnsw (embedding halfvec_cosine_ops);

CREATE INDEX IF NOT EXISTS chunks_v2_episode_segment_idx
  ON chunks_v2 (episode_id, segment_index);

CREATE INDEX IF NOT EXISTS chunks_v2_text_fts_idx
  ON chunks_v2 USING gin (to_tsvector('english', text));

-- ── Evaluation functions ─────────────────────────────────────────────────────
-- Both search only the given episodes with an exact (non-ANN) scan — the "+ 0"
-- keeps the planner off the HNSW index, so the comparison isn't skewed by
-- index post-filtering.

-- Old table, same 0.7 vector + 0.3 ts_rank blend as production match_chunks.
CREATE OR REPLACE FUNCTION eval_match_chunks_v1(
  query_embedding halfvec(1024),
  query_text      text,
  episode_ids     uuid[],
  match_count     int DEFAULT 10
)
RETURNS TABLE (chunk_id uuid, episode_id uuid, guest text, title text, timestamp_start text, text text, similarity float)
LANGUAGE sql STABLE
AS $$
  WITH c AS (
    SELECT c.id, c.episode_id, e.guest, e.title, c.timestamp_start, c.text,
           1 - ((c.embedding <=> query_embedding) + 0) AS vector_score
    FROM chunks c JOIN episodes e ON e.id = c.episode_id
    WHERE c.is_guest = true AND c.episode_id = ANY(episode_ids)
    ORDER BY (c.embedding <=> query_embedding) + 0
    LIMIT match_count * 4
  )
  SELECT id, episode_id, guest, title, timestamp_start, text,
         0.7 * vector_score + 0.3 * LEAST(ts_rank(to_tsvector('english', text), plainto_tsquery('english', query_text)) * 10.0, 1.0)
  FROM c ORDER BY 7 DESC LIMIT match_count;
$$;

-- New table, vector only (hybrid + rerank come in the next improvement).
CREATE OR REPLACE FUNCTION eval_match_chunks_v2(
  query_embedding halfvec(1024),
  episode_ids     uuid[],
  match_count     int DEFAULT 10
)
RETURNS TABLE (chunk_id uuid, episode_id uuid, guest text, title text, timestamp_start text, question text, segment_index int, text text, similarity float)
LANGUAGE sql STABLE
AS $$
  SELECT c.id, c.episode_id, e.guest, e.title, c.timestamp_start, c.question, c.segment_index, c.text,
         1 - ((c.embedding <=> query_embedding) + 0)
  FROM chunks_v2 c JOIN episodes e ON e.id = c.episode_id
  WHERE c.episode_id = ANY(episode_ids)
  ORDER BY (c.embedding <=> query_embedding) + 0
  LIMIT match_count;
$$;
