-- Episodes are keyed by transcript folder name: several folders share a video_id,
-- so video_id alone silently dropped episodes at ingest.
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE;
