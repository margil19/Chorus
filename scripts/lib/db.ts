import path from 'path'
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

export const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export const TRANSCRIPTS_DIR =
  process.env.TRANSCRIPTS_DIR ?? '/Users/margilgandhi/projects/lennys-podcast-transcripts/episodes'
