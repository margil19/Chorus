'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Link from 'next/link'
import FeatureNav from '../components/FeatureNav'
import type {
  AskApiResponse,
  AnswerSection,
  Source,
  GuestContext,
  Voice,
} from '../api/ask/route'

// ── Constants ─────────────────────────────────────────────────────────────────

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

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

function stripBold(text: string): string {
  return text.replace(/\*\*/g, '')
}

function extractSeconds(url: string): number {
  const match = url.match(/[?&]t=(\d+)/)
  return match ? parseInt(match[1], 10) : 0
}

// ── Shared label style ────────────────────────────────────────────────────────

const SECTION_LABEL_STYLE: React.CSSProperties = {
  color: 'rgba(232,84,58,0.7)',
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

// ── Results components (duplicated from home page) ────────────────────────────

function SynthesisCard({ sections, bottomLine }: { sections: AnswerSection[]; bottomLine: string }) {
  return (
    <div className="animate-fade-in overflow-hidden"
      style={{ background: 'linear-gradient(145deg, #1C0F0A, #0d0908)', border: '1px solid rgba(232,84,58,0.2)', borderRadius: '24px' }}>
      <div className="px-8 pt-6 pb-7">
        <p style={{ ...SECTION_LABEL_STYLE, marginBottom: '1.25rem' }}>Synthesis</p>
        <div className="space-y-5">
          {sections.map((section, i) => (
            <div key={i} className="animate-section" style={{ animationDelay: `${i * 120}ms` }}>
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
            <p className="text-sm font-medium leading-6" style={{ color: 'white' }}>{bottomLine}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function VoiceCard({
  voice, source, onOpen, activeClip, setActiveClip,
}: {
  voice: Voice; source: Source | null; onOpen: () => void
  activeClip: string | null; setActiveClip: (g: string | null) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const showClip = activeClip === voice.guest
  return (
    <div onClick={onOpen}
      className="bg-white rounded-2xl cursor-pointer transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-[0_8px_24px_rgba(0,0,0,0.12)] flex flex-col"
      style={{ border: '1px solid rgba(0,0,0,0.08)', padding: '1.5rem', fontFamily: FONT }}>
      <div className="flex items-center gap-3 mb-4">
        <div className="shrink-0 rounded-full bg-[#0a0a0a] flex items-center justify-center"
          style={{ width: '44px', height: '44px', minWidth: '44px' }}>
          <span style={{ color: 'white', fontSize: '14px', fontWeight: 600, lineHeight: 1 }}>
            {getInitials(voice.guest)}
          </span>
        </div>
        <div className="min-w-0">
          <p style={{ fontSize: '16px', fontWeight: 600, color: '#0a0a0a', lineHeight: 1.3 }}>{voice.guest}</p>
          <p className="truncate" style={{ fontSize: '13px', color: '#737373', marginTop: '2px' }}>
            {source?.episode_title ?? ''}
          </p>
        </div>
      </div>
      <div style={{ height: '1px', background: 'rgba(0,0,0,0.06)', marginBottom: '1rem' }} />
      <div className="flex-1 mb-4">
        <p className={!expanded ? 'line-clamp-4' : ''}
          style={{ fontSize: '15px', color: '#404040', lineHeight: 1.7, marginBottom: '0.4rem' }}>
          {voice.summary}
        </p>
        <button onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
          className="transition-colors duration-150" style={{ fontSize: '13px', color: '#E8543A' }}>
          {expanded ? 'Show less' : 'Read more →'}
        </button>
      </div>
      {source?.video_id && (
        <iframe width="100%"
          style={{ aspectRatio: '16/9', borderRadius: '8px', border: 'none', marginBottom: '1rem', display: showClip ? 'block' : 'none' }}
          src={showClip ? `https://www.youtube.com/embed/${source.video_id}?start=${extractSeconds(source.youtube_url)}&autoplay=1` : undefined}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      )}
      {source?.video_id && (
        <button onClick={(e) => { e.stopPropagation(); setActiveClip(showClip ? null : voice.guest) }}
          className="inline-flex items-center gap-1.5 rounded-[100px] transition-all duration-200 self-start"
          style={{ background: 'white', border: '1px solid rgba(0,0,0,0.12)', color: '#0a0a0a', padding: '0.3rem 0.9rem', fontSize: '12px', fontWeight: 500 }}
          onMouseEnter={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.background = '#E8543A'; el.style.color = 'white'; el.style.borderColor = '#E8543A' }}
          onMouseLeave={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.background = 'white'; el.style.color = '#0a0a0a'; el.style.borderColor = 'rgba(0,0,0,0.12)' }}
        >
          {showClip ? '✕ Hide clip' : '▶ Watch clip'}
        </button>
      )}
    </div>
  )
}

function VoiceCardsGrid({ voices, sources, onOpen }: {
  voices: Voice[]; sources: Source[]; onOpen: (s: Source) => void
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
            <VoiceCard key={i} voice={voice} source={source}
              onOpen={source ? () => onOpen(source) : () => {}}
              activeClip={activeClip} setActiveClip={setActiveClip}
            />
          )
        })}
      </div>
    </div>
  )
}

function ConsensusContrarianRow({ consensus, contrarian }: { consensus: string | null; contrarian: string | null }) {
  if (!consensus && !contrarian) return null
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 animate-fade-in-delay">
      {consensus && (
        <div style={{ background: '#1a0e0b', borderLeft: '3px solid #E8543A', borderRadius: 0, overflow: 'hidden' }}>
          <div className="px-5 py-4">
            <p style={{ ...SECTION_LABEL_STYLE, marginBottom: '0.5rem' }}>Where guests agree</p>
            <p className="text-sm leading-6" style={{ color: 'rgba(255,255,255,0.8)' }}>{stripBold(consensus)}</p>
          </div>
        </div>
      )}
      {contrarian && (
        <div style={{ background: '#1a0e0b', borderLeft: '3px solid rgba(255,255,255,0.15)', borderRadius: 0, overflow: 'hidden' }}>
          <div className="px-5 py-4">
            <p style={{ ...SECTION_LABEL_STYLE, marginBottom: '0.5rem' }}>Contrarian take</p>
            <p className="text-sm leading-6" style={{ color: 'rgba(255,255,255,0.8)' }}>{stripBold(contrarian)}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function AnswerDisplay({ response, onOpenSource }: { response: AskApiResponse; onOpenSource: (s: Source) => void }) {
  return (
    <div className="mt-6 space-y-4">
      <SynthesisCard sections={response.sections} bottomLine={response.bottom_line} />
      {response.voices && response.voices.length > 0 && (
        <VoiceCardsGrid voices={response.voices} sources={response.sources} onOpen={onOpenSource} />
      )}
      <ConsensusContrarianRow consensus={response.consensus} contrarian={response.contrarian} />
    </div>
  )
}

// ── Guest drawer ──────────────────────────────────────────────────────────────

function GuestContextRow({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null
  return (
    <div>
      <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, marginBottom: '0.2rem' }}>{label}</p>
      <p style={{ color: 'white', fontSize: '14px', fontWeight: 500, lineHeight: 1.5 }}>{value}</p>
    </div>
  )
}

function GuestDrawer({ source, onClose }: { source: Source | null; onClose: () => void }) {
  useEffect(() => {
    if (source) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
    return () => { document.body.style.overflow = '' }
  }, [source])

  const ctx: GuestContext | null = source?.guest_context ?? null

  return (
    <div className={`fixed inset-0 z-50 transition-all duration-300 ${source ? 'pointer-events-auto' : 'pointer-events-none'}`}>
      <div className={`absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity duration-300 ${source ? 'opacity-100' : 'opacity-0'}`} onClick={onClose} />
      <div className={`absolute right-0 top-0 h-full w-full max-w-[440px] flex flex-col transition-transform duration-300 ease-out ${source ? 'translate-x-0' : 'translate-x-full'}`}
        style={{ background: '#111111', borderLeft: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="flex items-start justify-between"
          style={{ padding: '2rem', paddingBottom: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="min-w-0 pr-4">
            <p style={{ color: 'white', fontSize: '20px', fontWeight: 600, lineHeight: 1.3 }}>{source?.guest}</p>
            <p className="line-clamp-2" style={{ color: 'rgba(255,255,255,0.5)', fontSize: '14px', marginTop: '0.25rem', lineHeight: 1.5 }}>
              {source?.episode_title}
            </p>
          </div>
          <button onClick={onClose} style={{ color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}
            className="hover:text-white transition-colors p-1 -m-1"><XIcon /></button>
        </div>
        <div className="flex-1 overflow-y-auto" style={{ padding: '2rem' }}>
          <div className="space-y-7">
            {ctx && (
              <div className="space-y-4">
                <p style={SECTION_LABEL_STYLE}>Background</p>
                <div className="space-y-3">
                  <GuestContextRow label="Role" value={ctx.guest_role} />
                  <GuestContextRow label="Company" value={ctx.company} />
                  <GuestContextRow label="Industry · Stage"
                    value={ctx.industry && ctx.company_stage ? `${ctx.industry} · ${ctx.company_stage}` : ctx.industry ?? ctx.company_stage}
                  />
                  {ctx.background && (
                    <p className="leading-6" style={{ color: 'rgba(255,255,255,0.6)', fontSize: '14px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '0.75rem' }}>
                      {ctx.background}
                    </p>
                  )}
                </div>
              </div>
            )}
            {source?.mental_models && source.mental_models.length > 0 && (
              <div>
                <p style={{ ...SECTION_LABEL_STYLE, marginBottom: '0.75rem' }}>Mental models</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {source.mental_models.map((model, i) => (
                    <span key={i} style={{ background: 'rgba(232,84,58,0.06)', border: '1px solid rgba(232,84,58,0.3)', color: 'rgba(255,255,255,0.8)', borderRadius: '100px', padding: '0.4rem 0.9rem', fontSize: '13px' }}>
                      {model}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {source?.key_quotes && source.key_quotes.length > 0 && (
              <div>
                <p style={{ ...SECTION_LABEL_STYLE, marginBottom: '0.75rem' }}>Key quotes</p>
                <div className="space-y-4">
                  {source.key_quotes.slice(0, 3).map((quote, i) => (
                    <blockquote key={i} style={{ borderLeft: '2px solid rgba(255,255,255,0.2)', paddingLeft: '1rem' }}>
                      <p style={{ color: 'rgba(255,255,255,0.7)', fontStyle: 'italic', fontSize: '14px', lineHeight: 1.6 }}>
                        &ldquo;{quote}&rdquo;
                      </p>
                    </blockquote>
                  ))}
                </div>
              </div>
            )}
            {!ctx && !source?.mental_models?.length && !source?.key_quotes?.length && (
              <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '14px' }}>No profile data available for this guest yet.</p>
            )}
          </div>
        </div>
        <div style={{ padding: '1.5rem 2rem', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <a href={source?.youtube_url} target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full transition-colors duration-150"
            style={{ background: '#E8543A', color: 'white', fontWeight: 600, fontSize: '14px', borderRadius: '100px', padding: '0.875rem' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.background = '#d14a30')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.background = '#E8543A')}>
            <YouTubeIcon className="w-4 h-4" />
            Watch Episode
          </a>
        </div>
      </div>
    </div>
  )
}

// ── Loading state ─────────────────────────────────────────────────────────────

function LoadingState() {
  const [dots, setDots] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setDots((d) => (d + 1) % 4), 400)
    return () => clearInterval(t)
  }, [])
  return (
    <div style={{ textAlign: 'center', padding: '4rem 0', color: '#737373', fontSize: '14px', fontFamily: FONT }}>
      Thinking across 270 episodes{'.'.repeat(dots)}
    </div>
  )
}

// ── Error ─────────────────────────────────────────────────────────────────────

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="mt-6 rounded-xl p-5 animate-fade-in" style={{ background: '#111111', border: '1px solid rgba(255,0,0,0.2)' }}>
      <p style={{ ...SECTION_LABEL_STYLE, color: 'rgba(255,100,100,0.8)', marginBottom: '0.375rem' }}>Error</p>
      <p className="text-sm" style={{ color: 'rgba(255,255,255,0.8)' }}>{message}</p>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AskPage() {
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<AskApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedSource, setSelectedSource] = useState<Source | null>(null)
  const [selectedBucket, setSelectedBucket] = useState<number | null>(null)
  const resultRef = useRef<HTMLDivElement>(null)

  const ask = useCallback(async (q: string, skipRewrite?: boolean) => {
    const trimmed = q.trim()
    if (!trimmed || loading) return
    setQuestion(trimmed)
    setLoading(true)
    setResponse(null)
    setError(null)
    setSelectedBucket(null)
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed, ...(skipRewrite && { skipRewrite: true }) }),
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
  }, [loading])

  const reset = () => {
    setResponse(null)
    setError(null)
    setQuestion('')
    setSelectedSource(null)
    setSelectedBucket(null)
  }

  const hasResult = Boolean(response || error || loading)

  return (
    <>
      <style>{`
        @keyframes askFadeUp {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes resultsEnter {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div className="min-h-screen flex flex-col" style={{ background: '#ffffff', fontFamily: FONT }}>

        {/* ── Sticky header ── */}
        <header style={{
          height: '56px',
          display: 'flex',
          alignItems: 'center',
          padding: '0 2rem',
          background: 'rgba(255,255,255,0.95)',
          borderBottom: '1px solid rgba(232,84,58,0.15)',
          position: 'sticky',
          top: 0,
          zIndex: 10,
          backdropFilter: 'blur(12px)',
        }}>
          <Link href="/" style={{
            color: '#0a0a0a',
            fontWeight: '500',
            fontSize: '15px',
            textDecoration: 'none',
          }}>
            Chorus
          </Link>
          {hasResult && (
            <button
              onClick={reset}
              style={{
                marginLeft: '1rem',
                background: 'transparent',
                border: '1px solid rgba(232,84,58,0.3)',
                color: '#E8543A',
                borderRadius: '100px',
                padding: '0.4rem 1rem',
                fontSize: '13px',
                cursor: 'pointer',
                fontFamily: FONT,
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(232,84,58,0.06)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'transparent')}
            >
              ← New question
            </button>
          )}
          <FeatureNav currentFeature="brain" />
        </header>

        {/* ── Main ── */}
        <main className="flex-1 flex flex-col items-center" style={{ padding: '0 2rem' }}>

          {/* ── Idle state ── */}
          {!hasResult && (
            <div
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', flex: 1, width: '100%', maxWidth: '640px',
                animation: 'askFadeUp 0.5s ease-out both',
              }}
            >
              {/* Title */}
              <h1 style={{ color: '#0a0a0a', fontSize: '2rem', fontWeight: 600, letterSpacing: '-0.02em', marginBottom: '0.5rem', textAlign: 'center' }}>
                The Brain
              </h1>
              <p style={{ color: '#737373', fontSize: '15px', marginBottom: '2.5rem', textAlign: 'center' }}>
                Ask anything across 270 episodes
              </p>

              {/* Search bar */}
              <div style={{ position: 'relative', width: '100%', animation: 'askFadeUp 0.5s ease-out 0.1s both' }}>
                <input
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') ask(question) }}
                  placeholder="Ask about product, growth, leadership..."
                  autoFocus
                  style={{
                    width: '100%', background: '#ffffff',
                    border: '1px solid rgba(232,84,58,0.25)', borderRadius: '100px',
                    padding: '1rem 8rem 1rem 1.5rem', color: '#0a0a0a', fontSize: '15px',
                    outline: 'none', fontFamily: FONT, boxSizing: 'border-box',
                    transition: 'border-color 0.15s, box-shadow 0.15s',
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = '#E8543A'
                    e.currentTarget.style.boxShadow = '0 0 0 3px rgba(232,84,58,0.08)'
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(232,84,58,0.25)'
                    e.currentTarget.style.boxShadow = 'none'
                  }}
                />
                <button
                  onClick={() => ask(question)}
                  disabled={!question.trim() || loading}
                  style={{
                    position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)',
                    background: '#E8543A', color: 'white', border: 'none', borderRadius: '100px',
                    padding: '0.5rem 1.25rem', fontSize: '14px', fontWeight: 500,
                    cursor: question.trim() ? 'pointer' : 'not-allowed', opacity: question.trim() ? 1 : 0.5,
                    fontFamily: FONT, transition: 'background 0.15s, opacity 0.15s',
                  }}
                  onMouseEnter={(e) => { if (question.trim()) (e.currentTarget as HTMLButtonElement).style.background = '#d14a30' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#E8543A' }}
                >
                  Ask
                </button>
              </div>

              {/* Bucket section */}
              <div style={{ width: '100%', marginTop: '2rem', animation: 'askFadeUp 0.5s ease-out 0.25s both' }}>
                <p style={{ color: '#737373', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '1rem', textAlign: 'center' }}>
                  Or explore by topic
                </p>

                {/* Bucket pills */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'center', marginBottom: '1rem' }}>
                  {QUESTION_BUCKETS.map((b, i) => {
                    const active = selectedBucket === i
                    return (
                      <button
                        key={b.label}
                        onClick={() => setSelectedBucket(active ? null : i)}
                        style={{
                          background: active ? 'rgba(232,84,58,0.08)' : 'transparent',
                          border: `1px solid ${active ? 'rgba(232,84,58,0.4)' : 'rgba(232,84,58,0.2)'}`,
                          color: active ? '#0a0a0a' : '#737373',
                          borderRadius: '100px', padding: '0.5rem 1.1rem',
                          fontSize: '13px', cursor: 'pointer', fontFamily: FONT,
                          transition: 'all 0.15s',
                        }}
                      >
                        {b.label}
                      </button>
                    )
                  })}
                </div>

                {/* Questions */}
                {selectedBucket !== null && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {QUESTION_BUCKETS[selectedBucket].questions.map((q) => (
                      <button
                        key={q}
                        onClick={() => ask(q, true)}
                        style={{
                          background: 'rgba(0,0,0,0.02)', border: '1px solid rgba(0,0,0,0.08)',
                          borderRadius: '12px', padding: '0.875rem 1.25rem',
                          color: '#404040', fontSize: '14px',
                          textAlign: 'left', width: '100%', cursor: 'pointer',
                          fontFamily: FONT, transition: 'all 0.15s',
                        }}
                        onMouseEnter={(e) => { const el = e.currentTarget; el.style.background = 'rgba(232,84,58,0.04)'; el.style.borderColor = 'rgba(232,84,58,0.25)' }}
                        onMouseLeave={(e) => { const el = e.currentTarget; el.style.background = 'rgba(0,0,0,0.02)'; el.style.borderColor = 'rgba(0,0,0,0.08)' }}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Results state ── */}
          {hasResult && (
            <div
              className="w-full mx-auto"
              style={{ maxWidth: '1100px', animation: 'resultsEnter 0.4s ease-out 0.1s both' }}
            >
              <div ref={resultRef} style={{ paddingTop: '2rem', paddingBottom: '6rem' }}>
                {loading && <LoadingState />}
                {!loading && error && <ErrorMessage message={error} />}
                {!loading && response && (
                  <AnswerDisplay response={response} onOpenSource={setSelectedSource} />
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      <GuestDrawer source={selectedSource} onClose={() => setSelectedSource(null)} />
    </>
  )
}
