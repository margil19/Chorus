-- Chorus database schema (Supabase / Postgres + pgvector).
-- Run once in the Supabase SQL editor on a fresh project. Idempotent.

CREATE EXTENSION IF NOT EXISTS vector;

-- ── episodes: one row per transcript folder ──────────────────────────────────
-- Keyed by `slug` (folder name). video_id is nullable: some folders' frontmatter
-- pointed at another episode's video, and some episodes have no known video.
CREATE TABLE IF NOT EXISTS episodes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               TEXT UNIQUE,
  guest              TEXT NOT NULL,
  title              TEXT NOT NULL,
  youtube_url        TEXT,
  video_id           TEXT UNIQUE,
  publish_date       DATE,
  description        TEXT,
  duration_seconds   FLOAT,
  duration           TEXT,
  view_count         INTEGER,
  channel            TEXT,
  keywords           TEXT[],
  -- Claude-enriched fields (scripts/ingest.ts)
  guest_context      JSONB,   -- {industry, company_stage, guest_role, company, background}
  mental_models      TEXT[],  -- key frameworks/concepts the guest discussed
  key_quotes         TEXT[],  -- 3–5 memorable direct quotes from the guest
  topic_depth_scores JSONB,   -- {topic: 0–10}
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ── chunks_v2: guest answer windows (scripts/lib/transcript.ts buildWindowChunks) ──
-- Each guest answer is split into ~1,200-char overlapping windows. Siblings share
-- (episode_id, segment_index) and are re-joined as context at answer time.
CREATE TABLE IF NOT EXISTS chunks_v2 (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id      UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  speaker         TEXT NOT NULL,
  timestamp_start TEXT NOT NULL,   -- HH:MM:SS of the turn the window starts in
  question        TEXT,            -- host question that preceded this answer
  segment_index   INT  NOT NULL,   -- answer segment within the episode
  window_index    INT  NOT NULL,   -- window within the segment
  text            TEXT NOT NULL,
  embedding       halfvec(1024),   -- voyage-3-large, input_type=document
  fts             tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (episode_id, segment_index, window_index)
);

CREATE INDEX IF NOT EXISTS chunks_v2_embedding_idx ON chunks_v2 USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_v2_episode_segment_idx ON chunks_v2 (episode_id, segment_index);
CREATE INDEX IF NOT EXISTS chunks_v2_fts_idx ON chunks_v2 USING gin (fts);

-- ── match_chunks_v2: candidates for /api/ask and the MCP tools ───────────────
-- Vector search (HNSW). If query_text is given, full-text matches are merged in
-- with reciprocal rank fusion; the app passes NULL because keyword candidates added
-- nothing once results are reranked (scripts/eval/compare-rerank.ts).
CREATE OR REPLACE FUNCTION match_chunks_v2(
  query_embedding halfvec(1024),
  query_text      text,
  match_count     int DEFAULT 40,
  candidate_count int DEFAULT 60
)
RETURNS TABLE (
  chunk_id uuid, episode_id uuid, guest text, title text, youtube_url text, video_id text,
  mental_models text[], key_quotes text[], guest_context jsonb,
  speaker text, timestamp_start text, question text, segment_index int, window_index int, text text,
  similarity float, vector_rank int, text_rank int, rrf_score float
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

-- ── match_guest_chunks_v2: one guest's nearest chunks (/api/debate) ──────────
-- Exact scan: an HNSW search filtered to one guest would post-filter a short
-- candidate list and often return nothing. "+ 0" keeps the planner off the index.
CREATE OR REPLACE FUNCTION match_guest_chunks_v2(
  query_embedding halfvec(1024),
  guest_name      text,
  match_count     int DEFAULT 20
)
RETURNS TABLE (
  chunk_id uuid, episode_id uuid, guest text, title text, youtube_url text, video_id text,
  mental_models text[], key_quotes text[], guest_context jsonb,
  speaker text, timestamp_start text, question text, segment_index int, window_index int, text text,
  similarity float, vector_rank int, text_rank int, rrf_score float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.id, c.episode_id, e.guest, e.title, e.youtube_url, e.video_id,
    COALESCE(e.mental_models, '{}'), COALESCE(e.key_quotes, '{}'), e.guest_context,
    c.speaker, c.timestamp_start, c.question, c.segment_index, c.window_index, c.text,
    1 - ((c.embedding <=> query_embedding) + 0),
    NULL::int, NULL::int, 0::float
  FROM chunks_v2 c
  JOIN episodes e ON e.id = c.episode_id
  WHERE e.guest = guest_name
  ORDER BY (c.embedding <=> query_embedding) + 0
  LIMIT match_count;
$$;
