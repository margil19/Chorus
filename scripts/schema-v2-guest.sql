-- ── Per-guest search over chunks_v2 (used by /api/debate) ────────────────────
-- Exact scan over one guest's episodes: an HNSW search filtered to a single guest
-- would post-filter a small candidate list and often return nothing. A guest has
-- at most a few hundred chunks, so the exact scan is cheap. "+ 0" keeps the
-- planner off the HNSW index.

CREATE OR REPLACE FUNCTION match_guest_chunks_v2(
  query_embedding halfvec(1024),
  guest_name      text,
  match_count     int DEFAULT 20
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
