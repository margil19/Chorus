-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable pg_trgm for trigram / full-text hybrid scoring
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Episodes: one row per transcript file (each episode has one main guest)
CREATE TABLE IF NOT EXISTS episodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest           TEXT NOT NULL,
  title           TEXT NOT NULL,
  youtube_url     TEXT,
  video_id        TEXT UNIQUE,
  publish_date    DATE,
  description     TEXT,
  duration_seconds FLOAT,
  duration        TEXT,
  view_count      INTEGER,
  channel         TEXT,
  keywords        TEXT[],
  -- Claude-enriched fields
  guest_context       JSONB,   -- {industry, company_stage, guest_role, company, background}
  mental_models       TEXT[],  -- key frameworks/concepts the guest discussed
  key_quotes          TEXT[],  -- 3–5 memorable direct quotes from the guest
  topic_depth_scores  JSONB,   -- {topic: 1–10} e.g. {"product_strategy": 8, "hiring": 6}
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Chunks: one row per merged speaker-turn
CREATE TABLE IF NOT EXISTS chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id      UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  speaker         TEXT NOT NULL,
  is_guest        BOOLEAN NOT NULL DEFAULT FALSE,
  timestamp_start TEXT NOT NULL,   -- HH:MM:SS of the first turn in this merged chunk
  text            TEXT NOT NULL,
  embedding       halfvec(1024),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Index for ANN search (cosine similarity)
-- Tune `lists` after loading all data: lists ≈ sqrt(total_rows)
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 200);

-- Fast lookup of all chunks for an episode
CREATE INDEX IF NOT EXISTS chunks_episode_id_idx ON chunks (episode_id);

-- Full-text search on chunk text
CREATE INDEX IF NOT EXISTS chunks_text_fts_idx
  ON chunks USING gin (to_tsvector('english', text));

-- ── Migration: restore embedding column as halfvec ───────────────────────────
-- Run this in the Supabase SQL editor if the column was dropped.
-- (Idempotent — safe to run even if the column already exists.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chunks' AND column_name = 'embedding'
  ) THEN
    ALTER TABLE chunks ADD COLUMN embedding halfvec(1024);
  END IF;
END $$;

-- ── RPC: match_chunks ────────────────────────────────────────────────────────
-- Hybrid search: two-phase retrieval.
--   Phase 1 — ANN vector search (uses HNSW index): fetches match_count * 4
--              candidates so re-ranking has meaningful signal to work with.
--   Phase 2 — Re-rank by 70 % cosine similarity + 30 % BM25-style ts_rank.
--              ts_rank is scaled ×10 then capped at 1.0 so both components
--              live on the same 0–1 scale before blending.
--
-- Also returns guest profile fields (mental_models, key_quotes, guest_context)
-- so the API can attach them to source cards without a second query.
CREATE OR REPLACE FUNCTION match_chunks(
  query_embedding halfvec(1024),
  query_text      text,
  match_count     int DEFAULT 60,
  guest_filter    text DEFAULT NULL
)
RETURNS TABLE (
  chunk_id        uuid,
  episode_id      uuid,
  speaker         text,
  is_guest        boolean,
  timestamp_start text,
  text            text,
  similarity      float,
  guest           text,
  title           text,
  youtube_url     text,
  video_id        text,
  mental_models   text[],
  key_quotes      text[],
  guest_context   jsonb
)
LANGUAGE sql STABLE
AS $$
  WITH vector_candidates AS (
    SELECT
      c.id                                    AS chunk_id,
      c.episode_id,
      c.speaker,
      c.is_guest,
      c.timestamp_start,
      c.text,
      1 - (c.embedding <=> query_embedding)   AS vector_score,
      e.guest,
      e.title,
      e.youtube_url,
      e.video_id,
      COALESCE(e.mental_models, '{}')         AS mental_models,
      COALESCE(e.key_quotes,    '{}')         AS key_quotes,
      e.guest_context
    FROM chunks c
    JOIN episodes e ON e.id = c.episode_id
    WHERE c.is_guest = true
      AND (guest_filter IS NULL OR e.guest = guest_filter)
    ORDER BY c.embedding <=> query_embedding
    -- Over-fetch so phase-2 re-ranking has room to promote text matches
    LIMIT match_count * 4
  )
  SELECT
    chunk_id,
    episode_id,
    speaker,
    is_guest,
    timestamp_start,
    text,
    (
      0.7 * vector_score
      + 0.3 * LEAST(
          ts_rank(
            to_tsvector('english', text),
            plainto_tsquery('english', query_text)
          ) * 10.0,
          1.0
        )
    )                                         AS similarity,
    guest,
    title,
    youtube_url,
    video_id,
    mental_models,
    key_quotes,
    guest_context
  FROM vector_candidates
  ORDER BY similarity DESC
  LIMIT match_count;
$$;
