import crypto from 'crypto'

/**
 * Content fingerprint: 8-word shingles sampled by hash (not position), so the same
 * conversation with an edited intro still matches. Compare with fingerprintSimilarity.
 */
export function contentFingerprint(text: string): Set<string> {
  const w = text.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i + 8 <= w.length; i++) {
    const s = w.slice(i, i + 8).join(' ')
    if (crypto.createHash('md5').update(s).digest()[0] < 16) out.add(s)
  }
  return out
}

export function fingerprintSimilarity(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const x of a) if (b.has(x)) n++
  return n / (a.size + b.size - n || 1)
}

export interface RawTurn {
  speaker: string
  timestamp: string
  text: string
}

export interface Chunk {
  speaker: string
  is_guest: boolean
  timestamp_start: string
  text: string
}

/**
 * Three header formats are handled:
 *
 * Format A — HH:MM:SS or MM:SS timestamp with named speaker:
 *   "Speaker Name (HH:MM:SS):"  /  "Speaker Name (MM:SS):"
 *
 * Format B — timestamp-only continuation (carry-forward speaker):
 *   "(HH:MM:SS):"  /  "(MM:SS):"
 *
 * Format C — no timestamp, speaker name only:
 *   "Speaker Name:"
 *   (timestamp_start is set to '' for these turns)
 */

const TS = /\d{2}:\d{2}(?::\d{2})?/

const SPEAKER_WITH_TS = new RegExp(`^([^(]+?)\\s*\\((${TS.source})\\):\\s*$`)
const CONTINUATION_TS = new RegExp(`^\\((${TS.source})\\):\\s*$`)
// Uppercase-led name, no parens, ends with colon — e.g. "Lenny:" or "Casey Winters:"
const SPEAKER_NO_TS = /^([A-Z][^:(\n]+?):\s*$/

export function parseTranscript(content: string): RawTurn[] {
  const lines = content.split('\n')
  const turns: RawTurn[] = []

  let currentSpeaker = ''
  let currentTimestamp = ''
  let currentLines: string[] = []
  // Track whether we have seen any header so we don't collect preamble text
  let started = false

  function flush() {
    const text = currentLines.join(' ').trim()
    if (text && started) {
      turns.push({ speaker: currentSpeaker, timestamp: currentTimestamp, text })
    }
    currentLines = []
  }

  for (const line of lines) {
    const speakerTsMatch = line.match(SPEAKER_WITH_TS)
    const contTsMatch = line.match(CONTINUATION_TS)
    const speakerNoTs = !speakerTsMatch && !contTsMatch ? line.match(SPEAKER_NO_TS) : null

    if (speakerTsMatch) {
      flush()
      currentSpeaker = speakerTsMatch[1].trim()
      currentTimestamp = speakerTsMatch[2]
      started = true
    } else if (contTsMatch) {
      flush()
      // carry-forward: currentSpeaker unchanged
      currentTimestamp = contTsMatch[1]
      started = true
    } else if (speakerNoTs) {
      flush()
      currentSpeaker = speakerNoTs[1].trim()
      currentTimestamp = ''
      started = true
    } else if (line.trim() && started) {
      currentLines.push(line.trim())
    }
  }

  flush()
  return turns
}

export function isGuestSpeaker(speaker: string): boolean {
  return speaker !== '' && !speaker.toLowerCase().includes('lenny')
}

/**
 * Merge consecutive turns from the same speaker into a single chunk.
 * Keeps the earliest timestamp as timestamp_start.
 */
export function mergeConsecutiveTurns(turns: RawTurn[]): Chunk[] {
  const chunks: Chunk[] = []

  for (const turn of turns) {
    if (!turn.text) continue

    const last = chunks[chunks.length - 1]
    if (last && last.speaker === turn.speaker) {
      last.text += ' ' + turn.text
    } else {
      chunks.push({
        speaker: turn.speaker,
        is_guest: isGuestSpeaker(turn.speaker),
        timestamp_start: turn.timestamp,
        text: turn.text,
      })
    }
  }

  return chunks
}

// ── v2 chunking: guest answer segments split into overlapping windows ─────────

export interface WindowChunk {
  speaker: string
  timestamp_start: string
  question: string | null
  segment_index: number
  window_index: number
  text: string
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length

// A host turn this short ("Mm-hmm.", "Interesting.") doesn't end the guest's answer.
const INTERJECTION_MAX_WORDS = 25
const MIN_SEGMENT_WORDS = 50
const WINDOW_TARGET_CHARS = 1200
const WINDOW_OVERLAP_CHARS = 200
const QUESTION_MAX_CHARS = 300

function splitSentences(text: string): string[] {
  return text.match(/[^.!?]+(?:[.!?]+["'”’)\]]*)\s*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text]
}

/**
 * Builds retrieval chunks while keeping speaker attribution from parseTranscript:
 * 1. Runs of guest turns separated only by short host interjections form one answer segment.
 * 2. Each segment remembers the host question that preceded it.
 * 3. Segments are split at sentence boundaries into ~WINDOW_TARGET_CHARS windows with overlap,
 *    each carrying the timestamp of the turn its first sentence came from.
 */
export function buildWindowChunks(turns: RawTurn[], minSegmentWords = MIN_SEGMENT_WORDS): WindowChunk[] {
  type Sentence = { text: string; timestamp: string }
  type Segment = { speaker: string; question: string | null; sentences: Sentence[]; words: number }

  const segments: Segment[] = []
  let lastQuestion: string | null = null
  let current: Segment | null = null

  for (const turn of turns) {
    if (!turn.text) continue
    if (isGuestSpeaker(turn.speaker)) {
      if (!current || current.speaker !== turn.speaker) {
        if (current) segments.push(current)
        current = { speaker: turn.speaker, question: lastQuestion, sentences: [], words: 0 }
      }
      for (const s of splitSentences(turn.text)) current.sentences.push({ text: s, timestamp: turn.timestamp })
      current.words += wordCount(turn.text)
    } else if (wordCount(turn.text) > INTERJECTION_MAX_WORDS) {
      if (current) segments.push(current)
      current = null
      lastQuestion =
        turn.text.length > QUESTION_MAX_CHARS
          ? '…' + turn.text.slice(-QUESTION_MAX_CHARS).replace(/^\S*\s+/, '')
          : turn.text
    }
  }
  if (current) segments.push(current)

  const out: WindowChunk[] = []
  let segmentIndex = 0
  for (const seg of segments) {
    if (seg.words < minSegmentWords) continue
    let windowIndex = 0
    let i = 0
    while (i < seg.sentences.length) {
      let j = i
      let len = 0
      while (j < seg.sentences.length && (len === 0 || len + seg.sentences[j].text.length <= WINDOW_TARGET_CHARS)) {
        len += seg.sentences[j].text.length + 1
        j++
      }
      // Fold a short tail into this window instead of emitting a fragment.
      const rest = seg.sentences.slice(j).reduce((n, s) => n + s.text.length + 1, 0)
      if (rest > 0 && rest < WINDOW_TARGET_CHARS / 3) j = seg.sentences.length

      out.push({
        speaker: seg.speaker,
        timestamp_start: seg.sentences[i].timestamp,
        question: seg.question,
        segment_index: segmentIndex,
        window_index: windowIndex++,
        text: seg.sentences.slice(i, j).map((s) => s.text).join(' '),
      })
      if (j >= seg.sentences.length) break

      let back = j
      let overlap = 0
      while (back - 1 > i && overlap + seg.sentences[back - 1].text.length <= WINDOW_OVERLAP_CHARS) {
        overlap += seg.sentences[back - 1].text.length + 1
        back--
      }
      i = back
    }
    segmentIndex++
  }
  return out
}

export type QuestionMode = 'all' | 'first' | 'none'

/**
 * The text actually embedded: guest + episode give every window context. The host
 * question goes only on the first window — on later windows it pulled in passages
 * where the guest had moved on to another topic (blind eval during the chunks_v2 pilot).
 */
export function embeddingText(guest: string, title: string, c: WindowChunk, questionMode: QuestionMode = 'first'): string {
  const include = c.question && (questionMode === 'all' || (questionMode === 'first' && c.window_index === 0))
  const q = include ? `Lenny asked: "${c.question}"\n` : ''
  return `Guest: ${guest}\nEpisode: ${title}\n${q}\n${c.speaker}: ${c.text}`
}
