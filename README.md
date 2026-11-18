# Chorus

Ask a question, get one synthesized answer drawn from 288 episodes of Lenny's Podcast — with the guests who said it, what they said, and a link to the moment in the episode.

Live at [chorus-steel.vercel.app](https://chorus-steel.vercel.app).

## Features

| Page | Route | What it does |
|---|---|---|
| **The Brain** | `/ask` | Ask anything; get a streamed synthesis, a bottom line, one card per guest, and where guests agree or disagree |
| **The Library** | `/mental-models` | Browse the frameworks guests use, with an AI explanation of each and who uses it |
| **The Arena** | `/debate` | Pick two guests and a question; see where they agree and where they split |
| **MCP server** | `/api/mcp` | The same knowledge as tools for Claude (`ask`, `search`, `get_guest`, `list_guests`) |

## How an answer is built

```
question
  → Voyage voyage-3-large embedding (input_type=query)
  → match_chunks_v2: top 20 guest-answer windows by vector similarity (pgvector HNSW)
  → Voyage rerank-2.5
  → diversify: ≤2 per guest, 1 per answer (no cap for a guest named in the question)
  → widen each window with its neighbours from the same answer (~2.4k chars) + Lenny's question
  → two Claude calls in parallel, streamed as NDJSON:
       synthesis: 3–4 sections, bottom line, consensus / contrarian
       voices:    one summary per guest
  → Server-Sent Events to the browser, section by section
```

The core lives in `lib/`:

- `lib/retrieval.ts` — embedding, search, rerank, diversity, neighbour expansion
- `lib/answer.ts` — prompts, the streaming NDJSON parser, and `answerQuestion()`, shared by `/api/ask` and the MCP `ask` tool

Eighteen starter questions are served instantly from `lib/precomputed-answers.json`.

## Stack

Next.js 16 (App Router) · React 19 · Tailwind 4 · Supabase Postgres + pgvector · Voyage AI (embeddings, rerank) · Anthropic Claude · Vercel

> This Next.js version has breaking changes from older releases — check `node_modules/next/dist/docs/` before writing framework code (see `AGENTS.md`).

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env.local` (gitignored — never commit it):

   | Variable | Used for |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Server-side database access |
   | `VOYAGE_API_KEY` | Embeddings and reranking |
   | `ANTHROPIC_API_KEY` | Synthesis, debate, mental-model detail, ingest enrichment |
   | `MCP_API_KEY` | Auth for `/api/mcp` and the OAuth flow |
   | `TRANSCRIPTS_DIR` | Optional, scripts only: path to the transcript folders |

   The same variables (except `TRANSCRIPTS_DIR`) must be set in the Vercel project.

3. Create the database: run `scripts/schema.sql` in the Supabase SQL editor.

4. Load data (see below), then:

   ```bash
   npm run dev
   ```

## Data pipeline

Source transcripts are markdown files with YAML frontmatter, one folder per episode (`<slug>/transcript.md`). Speaker lines look like `Name (HH:MM:SS):`; timestamp-only lines continue the previous speaker.

| Command | What it does |
|---|---|
| `npm run ingest` | Adds transcript folders not yet in the database: Claude enrichment (guest context, mental models, key quotes), then chunks and embeds. `--episode <slug>`, `--limit <n>` |
| `npm run rechunk -- --all` | Rebuilds every episode's `chunks_v2` rows from the transcripts and skips duplicate conversations. `--dry-run` for counts only |
| `npm run precompute -- --refresh` | Regenerates the 18 instant answers (needs `npm run dev` running) |
| `npm run eval` | Blind retrieval eval: Claude grades the top 5 passages per test question for several pipeline variants. `--questions scripts/eval/questions-named.json` for named-entity questions |
| `npx tsx scripts/eval/sweep-candidates.ts --k 20,40` | Same blind grading, comparing how many vector candidates go to the reranker |

**Chunking.** Each guest answer (consecutive guest turns, with short host interjections like "Mm-hmm" absorbed) becomes a segment. Segments are split at sentence boundaries into ~1,200-character windows with ~200 characters of overlap. Answers under 50 words are dropped. The embedded text carries the guest, the episode title and — on the first window of an answer — Lenny's question.

One-off repair scripts from the November 2026 data cleanup (dry run by default, `--apply` to write): `scripts/fix-episodes.ts`, `scripts/find-videos.ts`, `scripts/fix-titles.ts`, plus `scripts/eval/audit-transcripts.ts`.

### Known data issues

The transcript source is imperfect:

- Some folders share a `video_id` or carry another episode's frontmatter. Episodes are therefore keyed by folder `slug`, and frontmatter video IDs aren't trusted.
- Three "2.0" folders contain episode 1's transcript (April Dunford, Madhavan Ramanujam, Marty Cagan). Their rows exist but have no chunks.
- One row ("Ryan Singer", folder `ryan-hoover`) has a transcript that doesn't parse. The real Ryan Singer episode is separate and searchable.
- 10 episodes have no known YouTube video, so they show no clip button.

## MCP server

`/api/mcp` serves MCP over Streamable HTTP (stateless, one server instance per request).

- **Claude.ai connector:** add `https://chorus-steel.vercel.app/api/mcp`. Claude.ai runs the OAuth 2.0 + PKCE flow (`/.well-known/oauth-authorization-server`, `/api/oauth/*`). The issued token is derived from `MCP_API_KEY` with HMAC, so the key itself is never sent.
- **Claude Desktop / CLI:** send `Authorization: Bearer <MCP_API_KEY>` or `X-API-Key: <MCP_API_KEY>`. Claude Desktop needs the `mcp-remote` bridge:

  ```json
  {
    "mcpServers": {
      "chorus": {
        "command": "npx",
        "args": ["mcp-remote", "https://chorus-steel.vercel.app/api/mcp", "--header", "Authorization:Bearer <MCP_API_KEY>"]
      }
    }
  }
  ```

## Project structure

```
app/
  page.tsx                  landing page
  ask/ debate/ mental-models/   feature pages
  api/ask                   streamed answers (SSE)
  api/debate                two-guest comparison
  api/guests                guest list
  api/mental-models*        mental-model library, detail, situation search
  api/mcp                   MCP server
  api/oauth, .well-known    OAuth for the Claude.ai connector
lib/
  retrieval.ts  answer.ts  precomputed-answers.json
scripts/
  schema.sql                full database schema
  ingest.ts  rechunk.ts  precompute-answers.ts
  lib/                      transcript parsing + chunking, db client, Voyage client
  eval/                     retrieval eval and test questions
```

## Deploying

Pushing to `main` deploys to production on Vercel. Run `npm run build` before pushing — Vercel type-checks every TypeScript file, including `scripts/`.
