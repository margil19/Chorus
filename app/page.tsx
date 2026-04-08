'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import type {
  AskApiResponse,
  AnswerSection,
  Source,
  GuestContext,
  Voice,
} from './api/ask/route'

// ── Constants ─────────────────────────────────────────────────────────────────

const QUESTION_BUCKETS = [
  {
    label: 'Prioritization',
    questions: [
      'How do the best PMs think about prioritization?',
      'What frameworks do top PMs use to say no?',
      'How do you prioritize when everything feels urgent?',
    ],
  },
  {
    label: 'Growth',
    questions: [
      'How should early-stage startups approach growth?',
      'What separates organic growth from paid growth?',
      'When should a startup hire their first growth person?',
    ],
  },
  {
    label: 'Product Strategy',
    questions: [
      'What does good product strategy actually look like?',
      "How do you know when you've found product-market fit?",
      'How do the best PMs think about building a roadmap?',
    ],
  },
  {
    label: 'Hiring & Teams',
    questions: [
      'How do you build a culture of high ownership?',
      'What separates great product leaders from good ones?',
      'How do you hire a great PM?',
    ],
  },
  {
    label: 'Leadership',
    questions: [
      "What's the right way to run a product review?",
      'How do you influence without authority as a PM?',
      'When should you listen to users vs. ignore them?',
    ],
  },
  {
    label: 'Early Stage',
    questions: [
      'How should a first-time founder think about their MVP?',
      'What are the biggest mistakes PMs make at 0 to 1?',
      'How do you validate an idea before building it?',
    ],
  },
]

// ── Micro-helpers ─────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/)
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

/**
 * Render **bold** markdown spans as React nodes.
 * Used inside the dark synthesis card — strong text renders white.
 */
function renderBold(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i} style={{ fontWeight: 600, color: 'white' }}>
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    )
  )
}

/** Strip **bold** markers for plain-text fields (consensus, contrarian). */
function stripBold(text: string): string {
  return text.replace(/\*\*/g, '')
}

/** Extract the &t=N seconds value already embedded in youtube_url. */
function extractSeconds(url: string): number {
  const match = url.match(/[?&]t=(\d+)/)
  return match ? parseInt(match[1], 10) : 0
}

// ── Section label style (shared) ─────────────────────────────────────────────

const SECTION_LABEL_STYLE: React.CSSProperties = {
  color: 'rgba(255,255,255,0.4)',
  fontSize: '11px',
  fontWeight: 600,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function YouTubeIcon({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8z" />
      <polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02" fill="#0a0a0a" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

// ── Logo ──────────────────────────────────────────────────────────────────────

function HeroLogo() {
  return (
    <h1
      style={{
        fontSize: '28px',
        fontWeight: 600,
        color: 'white',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        letterSpacing: '-0.01em',
        lineHeight: 1,
        margin: 0,
      }}
    >
      Chorus
    </h1>
  )
}

// ── Search bar ────────────────────────────────────────────────────────────────

function SearchBar({
  question,
  loading,
  onChange,
  onSubmit,
}: {
  question: string
  loading: boolean
  onChange: (v: string) => void
  onSubmit: () => void
}) {
  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) onSubmit()
  }

  return (
    <div className="relative w-full">
      <div className="relative flex items-center">
        <input
          suppressHydrationWarning
          type="text"
          value={question}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ask about product, growth, leadership…"
          disabled={loading}
          className="
            w-full rounded-xl pl-5 pr-28 py-4
            text-base font-normal leading-6
            outline-none transition-all duration-200
            disabled:opacity-50
            bg-[rgba(255,255,255,0.06)]
            border border-[rgba(255,255,255,0.12)]
            text-white placeholder-[rgba(255,255,255,0.4)]
            focus:border-[rgba(255,255,255,0.4)] focus:ring-1 focus:ring-white/10
          "
        />
        <button
          onClick={onSubmit}
          disabled={loading || !question.trim()}
          className="
            absolute right-2
            flex items-center gap-1.5
            bg-white hover:bg-[rgba(255,255,255,0.85)]
            disabled:opacity-40 disabled:cursor-not-allowed
            text-[#0a0a0a] font-semibold text-sm
            rounded-lg px-4 py-2
            transition-colors duration-150
          "
        >
          Ask
        </button>
      </div>

      {/* Sweep bar — visible only while loading */}
      <div
        className={`
          absolute bottom-0 left-0 right-0 h-0.5 rounded-b-xl overflow-hidden
          transition-opacity duration-300
          ${loading ? 'opacity-100' : 'opacity-0'}
        `}
      >
        <div className="h-full w-1/2 bg-white/40 animate-loading-bar" />
      </div>
    </div>
  )
}

// ── Bucketed question chips ───────────────────────────────────────────────────

function BucketedQuestions({ onSelect }: { onSelect: (q: string) => void }) {
  const [selectedBucket, setSelectedBucket] = useState(0)
  const bucket = QUESTION_BUCKETS[selectedBucket]

  return (
    <div style={{ marginTop: '1.25rem' }}>
      {/* Bucket label pills */}
      <div className="flex flex-wrap gap-2 justify-center" style={{ marginBottom: '1rem' }}>
        {QUESTION_BUCKETS.map((b, i) => {
          const active = i === selectedBucket
          return (
            <button
              key={b.label}
              onClick={() => setSelectedBucket(i)}
              style={{
                background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
                border: `1px solid ${active ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)'}`,
                color: active ? 'white' : 'rgba(255,255,255,0.6)',
                borderRadius: '100px',
                padding: '0.5rem 1.25rem',
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all 0.15s',
                fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => {
                if (!active) {
                  const el = e.currentTarget
                  el.style.borderColor = 'rgba(255,255,255,0.4)'
                  el.style.color = 'rgba(255,255,255,0.85)'
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  const el = e.currentTarget
                  el.style.borderColor = 'rgba(255,255,255,0.2)'
                  el.style.color = 'rgba(255,255,255,0.6)'
                }
              }}
            >
              {b.label}
            </button>
          )
        })}
      </div>

      {/* Question chips for selected bucket */}
      <div className="flex flex-col gap-2">
        {bucket.questions.map((q) => (
          <button
            key={q}
            onClick={() => onSelect(q)}
            style={{
              width: '100%',
              textAlign: 'left',
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.3)',
              color: 'rgba(255,255,255,0.85)',
              borderRadius: '100px',
              padding: '0.75rem 1.25rem',
              fontSize: '13px',
              cursor: 'pointer',
              transition: 'all 0.15s',
              fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget
              el.style.borderColor = 'rgba(255,255,255,0.6)'
              el.style.color = 'white'
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget
              el.style.borderColor = 'rgba(255,255,255,0.3)'
              el.style.color = 'rgba(255,255,255,0.85)'
            }}
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Loading state ─────────────────────────────────────────────────────────────

function LightShimmerCard({ opacity = 1 }: { opacity?: number }) {
  return (
    <div
      className="bg-white rounded-2xl p-6 space-y-4"
      style={{ opacity, border: '1px solid rgba(0,0,0,0.08)' }}
    >
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-full animate-shimmer-light shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-3 animate-shimmer-light rounded-full w-2/5" />
          <div className="h-2.5 animate-shimmer-light rounded-full w-3/5" />
        </div>
      </div>
      <div style={{ height: '1px', background: 'rgba(0,0,0,0.06)' }} />
      <div className="space-y-2">
        <div className="h-2.5 animate-shimmer-light rounded-full" />
        <div className="h-2.5 animate-shimmer-light rounded-full w-5/6" />
        <div className="h-2.5 animate-shimmer-light rounded-full w-4/5" />
      </div>
      <div className="h-6 animate-shimmer-light rounded-full w-20" />
    </div>
  )
}

function LoadingState() {
  return (
    <div className="mt-6 space-y-5 animate-fade-in">
      <div className="flex items-center gap-2">
        <span className="text-sm" style={{ color: 'rgba(255,255,255,0.5)' }}>
          Thinking across 270 episodes
        </span>
        <span className="flex items-center gap-1 pt-0.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-1 h-1 rounded-full bg-white/60 animate-dot-bounce"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </span>
      </div>

      <div className="h-40 animate-shimmer-light rounded-3xl" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {[0, 1, 2, 3].map((i) => (
          <LightShimmerCard key={i} opacity={1 - i * 0.15} />
        ))}
      </div>
    </div>
  )
}

// ── Synthesis card (dark) ─────────────────────────────────────────────────────

function SynthesisCard({
  sections,
  bottomLine,
}: {
  sections: AnswerSection[]
  bottomLine: string
}) {
  return (
    <div
      className="animate-fade-in rounded-3xl overflow-hidden"
      style={{ background: 'linear-gradient(135deg, #0f0f0f 0%, #181818 100%)' }}
    >
      <div className="px-8 pt-6 pb-7">
        <p style={{ ...SECTION_LABEL_STYLE, marginBottom: '1.25rem' }}>Synthesis</p>

        <div className="space-y-5">
          {sections.map((section, i) => (
            <div
              key={i}
              className="animate-section"
              style={{ animationDelay: `${i * 120}ms` }}
            >
              <h3 className="text-sm font-semibold mb-1.5 leading-snug" style={{ color: 'white' }}>
                {section.header}
              </h3>
              <p className="text-sm leading-6" style={{ color: 'rgba(255,255,255,0.8)' }}>
                {renderBold(section.content)}
              </p>
            </div>
          ))}
        </div>

        {bottomLine && (
          <div className="mt-5 pt-5" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <p style={{ ...SECTION_LABEL_STYLE, marginBottom: '0.5rem' }}>Bottom line</p>
            <p className="text-sm font-medium leading-6" style={{ color: 'white' }}>
              {bottomLine}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Voice cards ───────────────────────────────────────────────────────────────

function VoiceCard({
  voice,
  source,
  onOpen,
  activeClip,
  setActiveClip,
}: {
  voice: Voice
  source: Source | null
  onOpen: () => void
  activeClip: string | null
  setActiveClip: (g: string | null) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const initials = getInitials(voice.guest)
  const showClip = activeClip === voice.guest

  return (
    <div
      onClick={onOpen}
      className="
        bg-white rounded-2xl cursor-pointer
        transition-all duration-300 ease-out
        hover:-translate-y-1 hover:shadow-[0_8px_24px_rgba(0,0,0,0.12)]
        flex flex-col
      "
      style={{
        border: '1px solid rgba(0,0,0,0.08)',
        padding: '1.5rem',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      {/* Top row: avatar + name + episode */}
      <div className="flex items-center gap-3 mb-4">
        <div
          className="shrink-0 rounded-full bg-[#0a0a0a] flex items-center justify-center"
          style={{ width: '44px', height: '44px', minWidth: '44px' }}
        >
          <span style={{ color: 'white', fontSize: '14px', fontWeight: 600, lineHeight: 1 }}>
            {initials}
          </span>
        </div>
        <div className="min-w-0">
          <p style={{ fontSize: '16px', fontWeight: 600, color: '#0a0a0a', lineHeight: 1.3 }}>
            {voice.guest}
          </p>
          <p
            className="truncate"
            style={{ fontSize: '13px', color: '#737373', marginTop: '2px' }}
          >
            {source?.episode_title ?? ''}
          </p>
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: '1px', background: 'rgba(0,0,0,0.06)', marginBottom: '1rem' }} />

      {/* Summary — clamped to 4 lines with toggle */}
      <div className="flex-1 mb-4">
        <p
          className={!expanded ? 'line-clamp-4' : ''}
          style={{ fontSize: '15px', color: '#404040', lineHeight: 1.7, marginBottom: '0.4rem' }}
        >
          {voice.summary}
        </p>
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
          className="transition-colors duration-150"
          style={{ fontSize: '13px', color: '#737373' }}
        >
          {expanded ? 'Show less' : 'Read more →'}
        </button>
      </div>

      {/* Inline YouTube embed */}
      {source?.video_id && (
        <iframe
          width="100%"
          style={{
            aspectRatio: '16/9',
            borderRadius: '8px',
            border: 'none',
            marginTop: '0',
            marginBottom: '1rem',
            display: showClip ? 'block' : 'none',
          }}
          src={showClip
            ? `https://www.youtube.com/embed/${source.video_id}?start=${extractSeconds(source.youtube_url)}&autoplay=1`
            : undefined}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      )}

      {/* Footer: Watch clip toggle */}
      {source?.video_id && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            setActiveClip(showClip ? null : voice.guest)
          }}
          className="
            inline-flex items-center gap-1.5
            bg-white hover:bg-[rgba(0,0,0,0.04)]
            text-[#0a0a0a]
            rounded-[100px]
            transition-colors duration-200
            self-start
          "
          style={{
            border: '1px solid rgba(0,0,0,0.12)',
            padding: '0.3rem 0.9rem',
            fontSize: '12px',
            fontWeight: 500,
          }}
        >
          {showClip ? '✕ Hide clip' : '▶ Watch clip'}
        </button>
      )}
    </div>
  )
}

function VoiceCardsGrid({
  voices,
  sources,
  onOpen,
}: {
  voices: Voice[]
  sources: Source[]
  onOpen: (s: Source) => void
}) {
  const [activeClip, setActiveClip] = useState<string | null>(null)
  const sourceByGuest = new Map(sources.map((s) => [s.guest, s]))

  return (
    <div>
      <p style={{ ...SECTION_LABEL_STYLE, marginBottom: '0.75rem' }}>Voices</p>
      <div className="flex flex-col gap-6">
        {voices.map((voice, i) => {
          const source = sourceByGuest.get(voice.guest) ?? null
          return (
            <VoiceCard
              key={i}
              voice={voice}
              source={source}
              onOpen={source ? () => onOpen(source) : () => {}}
              activeClip={activeClip}
              setActiveClip={setActiveClip}
            />
          )
        })}
      </div>
    </div>
  )
}

// ── Consensus + Contrarian row ────────────────────────────────────────────────

function ConsensusContrarianRow({
  consensus,
  contrarian,
}: {
  consensus: string | null
  contrarian: string | null
}) {
  if (!consensus && !contrarian) return null

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 animate-fade-in-delay">
      {consensus && (
        <div
          className="rounded-2xl overflow-hidden flex"
          style={{ background: '#111111', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <div className="w-[3px] shrink-0" style={{ background: 'rgba(255,255,255,0.25)' }} />
          <div className="px-5 py-4">
            <p style={{ ...SECTION_LABEL_STYLE, marginBottom: '0.5rem' }}>
              Where guests agree
            </p>
            <p className="text-sm leading-6" style={{ color: 'rgba(255,255,255,0.8)' }}>
              {stripBold(consensus)}
            </p>
          </div>
        </div>
      )}
      {contrarian && (
        <div
          className="rounded-2xl overflow-hidden flex"
          style={{ background: '#111111', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <div className="w-[3px] shrink-0" style={{ background: 'rgba(255,255,255,0.15)' }} />
          <div className="px-5 py-4">
            <p style={{ ...SECTION_LABEL_STYLE, marginBottom: '0.5rem' }}>
              Contrarian take
            </p>
            <p className="text-sm leading-6" style={{ color: 'rgba(255,255,255,0.8)' }}>
              {stripBold(contrarian)}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Full answer display ───────────────────────────────────────────────────────

function AnswerDisplay({
  response,
  onOpenSource,
}: {
  response: AskApiResponse
  onOpenSource: (s: Source) => void
}) {
  return (
    <div className="mt-6 space-y-4">
      <SynthesisCard
        sections={response.sections}
        bottomLine={response.bottom_line}
      />

      {response.voices && response.voices.length > 0 && (
        <VoiceCardsGrid
          voices={response.voices}
          sources={response.sources}
          onOpen={onOpenSource}
        />
      )}

      <ConsensusContrarianRow
        consensus={response.consensus}
        contrarian={response.contrarian}
      />
    </div>
  )
}

// ── Guest profile drawer ──────────────────────────────────────────────────────

function GuestContextRow({
  label,
  value,
}: {
  label: string
  value: string | undefined
}) {
  if (!value) return null
  return (
    <div>
      <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, marginBottom: '0.2rem' }}>
        {label}
      </p>
      <p style={{ color: 'white', fontSize: '14px', fontWeight: 500, lineHeight: 1.5 }}>{value}</p>
    </div>
  )
}

function GuestDrawer({
  source,
  onClose,
}: {
  source: Source | null
  onClose: () => void
}) {
  useEffect(() => {
    if (source) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
    return () => { document.body.style.overflow = '' }
  }, [source])

  const ctx: GuestContext | null = source?.guest_context ?? null

  return (
    <div
      className={`
        fixed inset-0 z-50
        transition-all duration-300
        ${source ? 'pointer-events-auto' : 'pointer-events-none'}
      `}
    >
      {/* Backdrop */}
      <div
        className={`
          absolute inset-0 bg-black/70 backdrop-blur-sm
          transition-opacity duration-300
          ${source ? 'opacity-100' : 'opacity-0'}
        `}
        onClick={onClose}
      />

      {/* Slide-in panel */}
      <div
        className={`
          absolute right-0 top-0 h-full
          w-full max-w-[440px]
          flex flex-col
          transition-transform duration-300 ease-out
          ${source ? 'translate-x-0' : 'translate-x-full'}
        `}
        style={{ background: '#111111', borderLeft: '1px solid rgba(255,255,255,0.08)' }}
      >
        {/* Panel header */}
        <div
          className="flex items-start justify-between"
          style={{ padding: '2rem', paddingBottom: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.08)' }}
        >
          <div className="min-w-0 pr-4">
            <p style={{ color: 'white', fontSize: '20px', fontWeight: 600, lineHeight: 1.3 }}>
              {source?.guest}
            </p>
            <p
              className="line-clamp-2"
              style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px', marginTop: '0.25rem', lineHeight: 1.5 }}
            >
              {source?.episode_title}
            </p>
          </div>
          <button
            onClick={onClose}
            style={{ color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}
            className="hover:text-white transition-colors p-1 -m-1"
          >
            <XIcon />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto" style={{ padding: '2rem' }}>
          <div className="space-y-7">
            {/* Guest context */}
            {ctx && (
              <div className="space-y-4">
                <p style={SECTION_LABEL_STYLE}>Background</p>
                <div className="space-y-3">
                  <GuestContextRow label="Role" value={ctx.guest_role} />
                  <GuestContextRow label="Company" value={ctx.company} />
                  <GuestContextRow
                    label="Industry · Stage"
                    value={
                      ctx.industry && ctx.company_stage
                        ? `${ctx.industry} · ${ctx.company_stage}`
                        : ctx.industry ?? ctx.company_stage
                    }
                  />
                  {ctx.background && (
                    <p
                      className="leading-6"
                      style={{
                        color: 'rgba(255,255,255,0.6)',
                        fontSize: '14px',
                        borderTop: '1px solid rgba(255,255,255,0.08)',
                        paddingTop: '0.75rem',
                      }}
                    >
                      {ctx.background}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Mental models */}
            {source?.mental_models && source.mental_models.length > 0 && (
              <div>
                <p style={{ ...SECTION_LABEL_STYLE, marginBottom: '0.75rem' }}>Mental models</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {source.mental_models.map((model, i) => (
                    <span
                      key={i}
                      style={{
                        background: 'rgba(255,255,255,0.08)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        color: 'rgba(255,255,255,0.8)',
                        borderRadius: '100px',
                        padding: '0.4rem 0.9rem',
                        fontSize: '13px',
                        whiteSpace: 'normal',
                        wordBreak: 'break-word',
                      }}
                    >
                      {model}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Key quotes */}
            {source?.key_quotes && source.key_quotes.length > 0 && (
              <div>
                <p style={{ ...SECTION_LABEL_STYLE, marginBottom: '0.75rem' }}>Key quotes</p>
                <div className="space-y-4">
                  {source.key_quotes.slice(0, 3).map((quote, i) => (
                    <blockquote
                      key={i}
                      style={{
                        borderLeft: '2px solid rgba(255,255,255,0.2)',
                        paddingLeft: '1rem',
                      }}
                    >
                      <p
                        style={{
                          color: 'rgba(255,255,255,0.7)',
                          fontStyle: 'italic',
                          fontSize: '14px',
                          lineHeight: 1.6,
                        }}
                      >
                        &ldquo;{quote}&rdquo;
                      </p>
                    </blockquote>
                  ))}
                </div>
              </div>
            )}

            {/* Empty state */}
            {!ctx &&
              (!source?.mental_models?.length) &&
              (!source?.key_quotes?.length) && (
                <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '14px' }}>
                  No profile data available for this guest yet.
                </p>
              )}
          </div>
        </div>

        {/* Watch button */}
        <div style={{ padding: '1.5rem 2rem', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <a
            href={source?.youtube_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full hover:bg-[rgba(255,255,255,0.9)] transition-colors duration-150"
            style={{
              background: 'white',
              color: '#0a0a0a',
              fontWeight: 600,
              fontSize: '14px',
              borderRadius: '100px',
              padding: '0.875rem',
            }}
          >
            <YouTubeIcon className="w-4 h-4" />
            Watch Episode
          </a>
        </div>
      </div>
    </div>
  )
}

// ── Error ─────────────────────────────────────────────────────────────────────

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="mt-6 rounded-xl p-5 animate-fade-in" style={{ background: '#111111', border: '1px solid rgba(255,0,0,0.2)' }}>
      <p style={{ ...SECTION_LABEL_STYLE, color: 'rgba(255,100,100,0.8)', marginBottom: '0.375rem' }}>
        Error
      </p>
      <p className="text-sm" style={{ color: 'rgba(255,255,255,0.8)' }}>{message}</p>
    </div>
  )
}

// ── Page constants ────────────────────────────────────────────────────────────

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Home() {
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<AskApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedSource, setSelectedSource] = useState<Source | null>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  const [guestFilter, setGuestFilter] = useState<{ domain: string; guests: string[] } | null>(null)
  const [hoveredCard, setHoveredCard] = useState<number | null>(null)
  const card1InputRef = useRef<HTMLInputElement>(null)
  const [brainExpanded, setBrainExpanded] = useState(false)
  const [selectedBucket, setSelectedBucket] = useState<number | null>(null)

  // On mount: read ?guest= param and sessionStorage filter
  useEffect(() => {
    // Read guest filter from sessionStorage
    const raw = sessionStorage.getItem('chorus_guest_filter')
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { domain: string; guests: string[] }
        setGuestFilter(parsed)
      } catch { /* ignore */ }
    }

    // Read ?guest= URL param and auto-ask
    const params = new URLSearchParams(window.location.search)
    const guest = params.get('guest')
    if (guest) {
      // Clear the param from URL without reload
      const url = new URL(window.location.href)
      url.searchParams.delete('guest')
      window.history.replaceState({}, '', url.toString())
      // Auto-ask after a short delay so `ask` is stable
      setTimeout(() => {
        askWithGuest(guest)
      }, 100)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const askWithGuest = useCallback(async (guestName: string) => {
    const q = `What are ${guestName}'s key ideas and mental models?`
    setQuestion(q)
    setLoading(true)
    setResponse(null)
    setError(null)
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, skipRewrite: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Something went wrong. Please try again.')
      } else {
        setResponse(data as AskApiResponse)
        setTimeout(() => {
          resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 100)
      }
    } catch {
      setError('Network error — please check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  const ask = useCallback(
    async (q: string, skipRewrite?: boolean) => {
      const trimmed = q.trim()
      if (!trimmed || loading) return

      setQuestion(trimmed)
      setLoading(true)
      setResponse(null)
      setError(null)

      // If guest filter active, append guest list to question
      const guestSuffix = guestFilter
        ? ` Focus only on these guests: ${guestFilter.guests.join(', ')}.`
        : ''

      try {
        const res = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: trimmed + guestSuffix, ...(skipRewrite && { skipRewrite: true }) }),
        })

        const data = await res.json()

        if (!res.ok) {
          setError(data.error ?? 'Something went wrong. Please try again.')
        } else {
          setResponse(data as AskApiResponse)
          setTimeout(() => {
            resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }, 100)
        }
      } catch {
        setError('Network error — please check your connection and try again.')
      } finally {
        setLoading(false)
      }
    },
    [loading, guestFilter]
  )

  const handleChipSelect = (q: string) => {
    setQuestion(q)
    ask(q, true)
  }

  const reset = () => {
    setResponse(null)
    setError(null)
    setQuestion('')
    setSelectedSource(null)
    setBrainExpanded(false)
    setSelectedBucket(null)
  }

  const clearGuestFilter = () => {
    sessionStorage.removeItem('chorus_guest_filter')
    setGuestFilter(null)
  }

  const hasResult = Boolean(response || error || loading)

  // ── Card style helper ─────────────────────────────────────────────────────────

  const cardStyle = (
    hoverShadow: string,
    bg: string,
    borderDefault: string,
    delay: string,
    idx: number,
  ): React.CSSProperties => {
    const hovered = hoveredCard === idx
    return {
      width: '340px',
      height: '420px',
      borderRadius: '24px',
      position: 'relative',
      cursor: 'pointer',
      overflow: 'hidden',
      background: bg,
      border: `1px solid ${borderDefault}`,
      boxShadow: hovered ? hoverShadow : 'none',
      transform: hovered ? 'translateY(-8px) scale(1.02)' : 'translateY(0) scale(1)',
      transition: 'box-shadow 0.3s ease, transform 0.3s cubic-bezier(0.4,0,0.2,1), border-color 0.3s ease',
      animation: loading ? `cardsExit 0.35s ease-in forwards` : `cardReveal 0.7s ease-out ${delay} both`,
      display: 'flex',
      flexDirection: 'column',
      fontFamily: FONT,
    }
  }

  return (
    <>
      <style>{`
        @keyframes cardReveal {
          0%   { opacity: 0; transform: translateY(40px) scale(0.96); }
          60%  { opacity: 1; transform: translateY(-6px) scale(1.01); }
          80%  { transform: translateY(3px) scale(0.99); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes fadeInDown {
          from { opacity: 0; transform: translateY(-10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* ── Idle state — three-card homepage ── */}
      {!hasResult && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: '#080C14',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            fontFamily: FONT,
            paddingTop: '3rem',
          }}
        >
          {/* Logo + tagline */}
          <div
            style={{
              textAlign: 'center',
              animation: 'fadeInDown 0.6s ease-out forwards',
              marginBottom: '3rem',
            }}
          >
            <h1 style={{ fontSize: '1.25rem', fontWeight: 500, color: 'white', letterSpacing: '0.02em', margin: 0, lineHeight: 1 }}>
              Chorus
            </h1>
            <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '14px', marginTop: '0.5rem', marginBottom: 0 }}>
              270 podcast episodes. One place to think.
            </p>

            {guestFilter && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.625rem', marginTop: '1rem' }}>
                <span style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '100px', padding: '0.3rem 0.875rem', fontSize: '13px', color: 'rgba(255,255,255,0.65)' }}>
                  Filtering to {guestFilter.guests.length} {guestFilter.domain} guests
                </span>
                <button
                  onClick={clearGuestFilter}
                  style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.35)', fontSize: '13px', cursor: 'pointer', padding: 0, transition: 'color 0.15s' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'white')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.35)')}
                >
                  × clear
                </button>
              </div>
            )}
          </div>

          {/* ── Three feature cards ── */}
          <div
            style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start', justifyContent: 'center', padding: '0 2rem' }}
          >

            {/* ── CARD 1 — THE BRAIN ── */}
            <div
              style={cardStyle('0 24px 80px rgba(232,84,58,0.18), 0 0 0 1px rgba(232,84,58,0.4)', '#1C0F0A', 'rgba(232,84,58,0.35)', '0.1s', 0)}
              onMouseEnter={() => setHoveredCard(0)}
              onMouseLeave={() => setHoveredCard(null)}
              onClick={(e) => { e.stopPropagation(); window.location.href = '/ask' }}
            >
              <div style={{ flex: 1, padding: '2rem 2rem 1rem', display: 'flex', flexDirection: 'column' }}>
                <span style={{ color: 'rgba(232,84,58,0.7)', fontSize: '12px', letterSpacing: '0.15em', fontWeight: 500 }}>01</span>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="160" height="120" viewBox="0 0 160 120" style={{ opacity: hoveredCard === 0 ? 1 : 0.7, transition: 'opacity 0.3s' }}>
                    {([
                      [20,60,45,25],[45,25,80,45],[80,45,110,20],[110,20,140,50],
                      [140,50,120,85],[120,85,75,95],[75,95,35,80],[35,80,20,60],
                      [80,45,120,85],[45,25,75,95],
                    ] as [number,number,number,number][]).map(([x1,y1,x2,y2], i) => (
                      <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
                        stroke="rgba(232,84,58,0.25)" strokeWidth="1"
                        strokeDasharray="100"
                        style={{ animation: `drawLine 1.5s ease-out ${0.2 + i * 0.18}s forwards`, opacity: 0 }}
                      />
                    ))}
                    {([[20,60],[45,25],[80,45],[110,20],[140,50],[120,85],[75,95],[35,80]] as [number,number][]).map(([cx,cy], i) => (
                      <circle key={i} cx={cx} cy={cy} r="3" fill="rgba(232,84,58,0.8)"
                        style={{ animation: `pulse 2.5s ease-in-out ${i * 0.3}s infinite` }}
                      />
                    ))}
                  </svg>
                </div>
              </div>
              <div style={{ padding: '1.5rem 2rem 2rem' }}>
                <p style={{ color: 'white', fontSize: '1.5rem', fontWeight: 600, letterSpacing: '-0.02em', marginBottom: '0.5rem' }}>The Brain</p>
                <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '13px', lineHeight: 1.5, marginBottom: '1.25rem' }}>Ask anything across 270 episodes</p>
                <a href="/ask" onClick={(e) => e.stopPropagation()}
                  style={{ color: '#E8543A', fontSize: '13px', fontWeight: 500, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                  Ask anything →
                </a>
              </div>
            </div>

            {/* ── CARD 2 — THE LIBRARY ── */}
            <div
              style={cardStyle('0 24px 80px rgba(56,189,248,0.18), 0 0 0 1px rgba(56,189,248,0.4)', '#081828', 'rgba(56,189,248,0.35)', '0.2s', 1)}
              onMouseEnter={() => setHoveredCard(1)}
              onMouseLeave={() => setHoveredCard(null)}
              onClick={(e) => { e.stopPropagation(); window.location.href = '/mental-models' }}
            >
              <div style={{ flex: 1, padding: '2rem 2rem 1rem', display: 'flex', flexDirection: 'column' }}>
                <span style={{ color: 'rgba(56,189,248,0.7)', fontSize: '12px', letterSpacing: '0.15em', fontWeight: 500 }}>02</span>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="120" height="100" viewBox="0 0 120 100" style={{ opacity: hoveredCard === 1 ? 1 : 0.7, transition: 'opacity 0.3s' }}>
                    {Array.from({ length: 20 }).map((_, i) => {
                      const col = i % 4
                      const row = Math.floor(i / 4)
                      const highlighted = [1, 4, 7, 11, 14, 18].includes(i)
                      return (
                        <rect key={i} x={col * 24 + 6} y={row * 20 + 5} width="16" height="16" rx="4"
                          fill={highlighted ? 'rgba(56,189,248,0.45)' : 'rgba(56,189,248,0.15)'}
                          stroke="rgba(56,189,248,0.35)" strokeWidth="1"
                          style={{ animation: `gridIn 0.3s ease-out ${i * 0.05}s both` }}
                        />
                      )
                    })}
                  </svg>
                </div>
              </div>
              <div style={{ padding: '1.5rem 2rem 2rem' }}>
                <p style={{ color: 'white', fontSize: '1.5rem', fontWeight: 600, letterSpacing: '-0.02em', marginBottom: '0.5rem' }}>The Library</p>
                <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '13px', lineHeight: 1.5, marginBottom: '1.25rem' }}>Browse 1,900+ mental models by theme</p>
                <div style={{ color: '#38BDF8', fontSize: '13px', fontWeight: 500 }}>Explore →</div>
              </div>
            </div>

            {/* ── CARD 3 — THE ARENA ── */}
            <div
              style={cardStyle('0 24px 80px rgba(167,139,250,0.18), 0 0 0 1px rgba(167,139,250,0.4)', '#110E1F', 'rgba(167,139,250,0.35)', '0.3s', 2)}
              onMouseEnter={() => setHoveredCard(2)}
              onMouseLeave={() => setHoveredCard(null)}
              onClick={(e) => { e.stopPropagation(); window.location.href = '/debate' }}
            >
              <div style={{ flex: 1, padding: '2rem 2rem 1rem', display: 'flex', flexDirection: 'column' }}>
                <span style={{ color: 'rgba(167,139,250,0.7)', fontSize: '12px', letterSpacing: '0.15em', fontWeight: 500 }}>03</span>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="140" height="100" viewBox="0 0 140 100" style={{ opacity: hoveredCard === 2 ? 1 : 0.7, transition: 'opacity 0.3s' }}>
                    <line x1="70" y1="10" x2="70" y2="90"
                      stroke="rgba(167,139,250,0.3)" strokeWidth="1"
                      strokeDasharray="4 4" strokeDashoffset="200"
                      style={{ animation: 'drawDash 1s ease-out 0.7s forwards' }}
                    />
                    <g style={{ animation: 'slideFromLeft 0.6s ease-out 0.3s both' }}>
                      <circle cx="35" cy="35" r="18" fill="rgba(167,139,250,0.2)" stroke="rgba(167,139,250,0.5)" strokeWidth="1.5" />
                      <path d="M10,90 Q35,62 60,90" fill="rgba(167,139,250,0.12)" stroke="rgba(167,139,250,0.3)" strokeWidth="1.5" />
                    </g>
                    <g style={{ animation: 'slideFromRight 0.6s ease-out 0.5s both' }}>
                      <circle cx="105" cy="35" r="18" fill="rgba(167,139,250,0.2)" stroke="rgba(167,139,250,0.5)" strokeWidth="1.5" />
                      <path d="M80,90 Q105,62 130,90" fill="rgba(167,139,250,0.12)" stroke="rgba(167,139,250,0.3)" strokeWidth="1.5" />
                    </g>
                  </svg>
                </div>
              </div>
              <div style={{ padding: '1.5rem 2rem 2rem' }}>
                <p style={{ color: 'white', fontSize: '1.5rem', fontWeight: 600, letterSpacing: '-0.02em', marginBottom: '0.5rem' }}>The Arena</p>
                <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '13px', lineHeight: 1.5, marginBottom: '1.25rem' }}>Pit any two guests against each other</p>
                <div style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 500 }}>Compare →</div>
              </div>
            </div>

          </div>

          {/* Footer */}
          <div style={{ position: 'absolute', bottom: '1.5rem', width: '100%', textAlign: 'center' }}>
            <p style={{ color: 'rgba(255,255,255,0.2)', fontSize: '12px', margin: 0, fontFamily: FONT }}>
              Transcripts from Lenny Rachitsky&rsquo;s open podcast archive&nbsp;&middot;&nbsp;
              <a href="https://www.lenny.fm" target="_blank" rel="noopener noreferrer"
                style={{ color: 'rgba(255,255,255,0.2)', textDecoration: 'underline', textUnderlineOffset: '3px' }}>
                lenny.fm
              </a>
            </p>
          </div>
        </div>
      )}

      {/* ── Results state ── */}
      {hasResult && (
        <div
          className="min-h-screen flex flex-col"
          style={{ background: '#080C14', animation: 'resultsEnter 0.4s ease-out 0.2s both' }}
        >
          <header
            className="sticky top-0 z-10 backdrop-blur-sm animate-fade-in"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(8,12,20,0.95)' }}
          >
            <div className="mx-auto flex items-center gap-4" style={{ maxWidth: '1100px', padding: '0.75rem 2rem' }}>
              <button onClick={reset} className="flex items-center gap-3 group">
                <span style={{ fontSize: '20px', fontWeight: 600, color: 'white', fontFamily: FONT, letterSpacing: '-0.01em' }}>Chorus</span>
                <span
                  className="text-xs transition-colors duration-150"
                  style={{ color: 'rgba(255,255,255,0.4)' }}
                  onMouseEnter={(e) => ((e.target as HTMLElement).style.color = 'rgba(255,255,255,0.7)')}
                  onMouseLeave={(e) => ((e.target as HTMLElement).style.color = 'rgba(255,255,255,0.4)')}
                >
                  New question
                </span>
              </button>
            </div>
          </header>

          <main className="flex-1 flex flex-col items-center justify-start pt-8 pb-24">
            <div className="w-full mx-auto" style={{ maxWidth: '1100px', padding: '0 2rem' }}>
              <div ref={resultRef}>
                {loading && <LoadingState />}
                {!loading && error && <ErrorMessage message={error} />}
                {!loading && response && (
                  <AnswerDisplay response={response} onOpenSource={setSelectedSource} />
                )}
              </div>
            </div>
          </main>
        </div>
      )}

      {/* Guest profile drawer */}
      <GuestDrawer source={selectedSource} onClose={() => setSelectedSource(null)} />
    </>
  )
}
