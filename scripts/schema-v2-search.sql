-- ── Hybrid search over chunks_v2 ─────────────────────────────────────────────
-- Vector and full-text candidates are retrieved independently, then merged with
-- reciprocal rank fusion (RRF). A passage that only matches on keywords (a named
-- framework, a company) can now enter the pool; reranking happens in the app.

ALTER TABLE chunks_v2
  ADD COLUMN IF NOT EXISTS fts tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;

DROP INDEX IF EXISTS chunks_v2_text_fts_idx;
CREATE INDEX IF NOT EXISTS chunks_v2_fts_idx ON chunks_v2 USING gin (fts);

CREATE OR REPLACE FUNCTION match_chunks_v2(
  query_embedding halfvec(1024),
  query_text      text,
  match_count     int DEFAULT 40,
  candidate_count int DEFAULT 60
)
RETURNS TABLE (
  chunk_id        uuid,
  episode_id      uuid,
  guest           text,
  title           text,
  youtube_url     text,
  video_id        text,
  mental_models   text[],
  key_quotes      text[],
  guest_context   jsonb,
  speaker         text,
  timestamp_start text,
  question        text,
  segment_index   int,
  window_index    int,
  text            text,
  similarity      float,
  vector_rank     int,
  text_rank       int,
  rrf_score       float
)
LANGUAGE sql STABLE
SET hnsw.ef_search = 100
AS $$
  WITH
  vec AS (
    SELECT id, (embedding <=> query_embedding) AS distance
    FROM chunks_v2
    ORDER BY embedding <=> query_embedding
    LIMIT candidate_count
  ),
  vec_ranked AS (
    SELECT id, distance, row_number() OVER (ORDER BY distance)::int AS rnk FROM vec
  ),
  -- OR the query's lexemes: plainto_tsquery ANDs every word, which almost never
  -- matches a natural-language question.
  q AS (
    SELECT NULLIF(replace(plainto_tsquery('english', query_text)::text, ' & ', ' | '), '')::tsquery AS tsq
  ),
  txt AS (
    SELECT c.id, ts_rank_cd(c.fts, q.tsq, 1) AS score
    FROM chunks_v2 c, q
    WHERE q.tsq IS NOT NULL AND c.fts @@ q.tsq
    ORDER BY score DESC
    LIMIT candidate_count
  ),
  txt_ranked AS (
    SELECT id, row_number() OVER (ORDER BY score DESC)::int AS rnk FROM txt
  ),
  fused AS (
    SELECT
      COALESCE(v.id, t.id) AS id,
      v.rnk AS vector_rank,
      t.rnk AS text_rank,
      COALESCE(1.0 / (60 + v.rnk), 0) + COALESCE(1.0 / (60 + t.rnk), 0) AS rrf_score
    FROM vec_ranked v
    FULL OUTER JOIN txt_ranked t ON t.id = v.id
  )
  SELECT
    c.id, c.episode_id, e.guest, e.title, e.youtube_url, e.video_id,
    COALESCE(e.mental_models, '{}'), COALESCE(e.key_quotes, '{}'), e.guest_context,
    c.speaker, c.timestamp_start, c.question, c.segment_index, c.window_index, c.text,
    1 - (c.embedding <=> query_embedding),
    f.vector_rank, f.text_rank, f.rrf_score
  FROM fused f
  JOIN chunks_v2 c ON c.id = f.id
  JOIN episodes e ON e.id = c.episode_id
  ORDER BY f.rrf_score DESC
  LIMIT match_count;
$$;
