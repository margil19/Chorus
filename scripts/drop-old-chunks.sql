-- Removes the original speaker-turn `chunks` table and everything that queried it
-- (applied 2026-11-17). Irreversible: the old rows could only be rebuilt by re-ingesting.
-- match_chunks had several overloads, so each is dropped by its full signature.

DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('match_chunks', 'eval_match_chunks_v1', 'eval_match_chunks_v2')
  LOOP
    EXECUTE 'DROP FUNCTION ' || f.sig;
    RAISE NOTICE 'dropped %', f.sig;
  END LOOP;
END $$;

DROP TABLE IF EXISTS chunks;
