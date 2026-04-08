'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import type { DebateApiResponse, DebateSource } from '../api/debate/route'

// ── Constants ─────────────────────────────────────────────────────────────────

const LABEL_STYLE: React.CSSProperties = {
  color: 'rgba(255,255,255,0.4)',
  fontSize: '11px',
  fontWeight: 600,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  marginBottom: '0.625rem',
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/)
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

// ── Guest type-ahead input ────────────────────────────────────────────────────

function GuestInput({
  label,
  value,
  onChange,
  guests,
  excludeGuest,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  guests: string[]
  excludeGuest: string
}) {
  const [isFocused, setIsFocused] = useState(false)
  const isSelected = value !== '' && guests.includes(value)

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase()
    const pool = guests.filter((g) => g !== excludeGuest)
    if (!q) return pool
    return pool.filter((g) => g.toLowerCase().includes(q))
  }, [value, guests, excludeGuest])

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <p
        style={{
          color: 'rgba(255,255,255,0.5)',
          fontSize: '12px',
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          marginBottom: '0.5rem',
          fontFamily: FONT,
        }}
      >
        {label}
      </p>

      {/* Input + dropdown wrapper — dropdown positions relative to this */}
      <div style={{ position: 'relative' }}>
        {/* Checkmark prefix when a valid guest is selected */}
        {isSelected && (
          <span
            style={{
              position: 'absolute',
              left: '1rem',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'rgba(255,255,255,0.55)',
              fontSize: '14px',
              pointerEvents: 'none',
              lineHeight: 1,
              zIndex: 1,
            }}
          >
            ✓
          </span>
        )}

        <input
          suppressHydrationWarning
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={(e) => {
            setIsFocused(true)
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.4)'
          }}
          onBlur={(e) => {
            setTimeout(() => setIsFocused(false), 150)
            e.currentTarget.style.borderColor = isSelected
              ? 'rgba(255,255,255,0.3)'
              : 'rgba(255,255,255,0.12)'
          }}
          placeholder="Type a guest name…"
          style={{
            width: '100%',
            background: 'rgba(255,255,255,0.06)',
            border: `1px solid ${isSelected ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)'}`,
            borderRadius: '12px',
            padding: isSelected ? '0.875rem 2.5rem 0.875rem 2.25rem' : '0.875rem 1rem',
            color: 'white',
            fontSize: '15px',
            outline: 'none',
            fontFamily: FONT,
            boxSizing: 'border-box',
          }}
        />

        {/* Clear button */}
        {isSelected && (
          <button
            type="button"
            onClick={() => onChange('')}
            style={{
              position: 'absolute',
              right: '0.75rem',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'rgba(255,255,255,0.4)',
              fontSize: '16px',
              cursor: 'pointer',
              background: 'none',
              border: 'none',
              lineHeight: 1,
              padding: 0,
              zIndex: 1,
            }}
            onMouseEnter={(e) =>
              ((e.currentTarget as HTMLButtonElement).style.color = 'white')
            }
            onMouseLeave={(e) =>
              ((e.currentTarget as HTMLButtonElement).style.color =
                'rgba(255,255,255,0.4)')
            }
          >
            ×
          </button>
        )}

        {/* Dropdown */}
        {isFocused && filtered.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              background: '#1a1a1a',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '8px',
              maxHeight: '200px',
              overflowY: 'auto',
              zIndex: 50,
            }}
          >
            {filtered.map((g) => (
              <div
                key={g}
                onMouseDown={(e) => {
                  e.preventDefault() // prevent onBlur before selection
                  onChange(g)
                  setIsFocused(false)
                }}
                style={{
                  padding: '0.75rem 1rem',
                  color: 'white',
                  fontSize: '14px',
                  cursor: 'pointer',
                  fontFamily: FONT,
                }}
                onMouseEnter={(e) => {
                  ;(e.currentTarget as HTMLDivElement).style.background =
                    'rgba(255,255,255,0.08)'
                }}
                onMouseLeave={(e) => {
                  ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
                }}
              >
                {g}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Combatant card ────────────────────────────────────────────────────────────

function CombatantCard({
  guest,
  source,
}: {
  guest: string
  source: DebateSource | null
}) {
  return (
    <div
      style={{
        background: '#ffffff',
        border: '1px solid rgba(0,0,0,0.08)',
        borderRadius: '16px',
        padding: '1.25rem 1.5rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.875rem',
        fontFamily: FONT,
      }}
    >
      {/* Avatar */}
      <div
        style={{
          width: '44px',
          height: '44px',
          minWidth: '44px',
          borderRadius: '100%',
          background: '#0a0a0a',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <span style={{ color: 'white', fontSize: '14px', fontWeight: 600, lineHeight: 1 }}>
          {getInitials(guest)}
        </span>
      </div>

      {/* Name + episode */}
      <div style={{ minWidth: 0, flex: 1 }}>
        <p style={{ fontSize: '16px', fontWeight: 600, color: '#0a0a0a', lineHeight: 1.3 }}>
          {guest}
        </p>
        {source && (
          <p
            className="truncate"
            style={{ fontSize: '13px', color: '#737373', marginTop: '2px' }}
          >
            {source.title}
          </p>
        )}
      </div>

      {/* Watch clip pill */}
      {source && (
        <a
          href={source.youtube_url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            background: 'transparent',
            border: '1px solid rgba(0,0,0,0.15)',
            color: '#404040',
            borderRadius: '100px',
            padding: '0.3rem 0.875rem',
            fontSize: '12px',
            fontWeight: 500,
            textDecoration: 'none',
            whiteSpace: 'nowrap',
            flexShrink: 0,
            fontFamily: FONT,
          }}
        >
          Watch clip
        </a>
      )}
    </div>
  )
}

// ── Position card ─────────────────────────────────────────────────────────────

function PositionCard({
  guest,
  position,
  relevant,
}: {
  guest: string
  position: string
  relevant: boolean
}) {
  return (
    <div
      style={{
        background: '#ffffff',
        border: '1px solid rgba(0,0,0,0.08)',
        borderRadius: '16px',
        padding: '1.5rem',
        fontFamily: FONT,
      }}
    >
      {/* Guest header */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '1rem' }}
      >
        <div
          style={{
            width: '32px',
            height: '32px',
            minWidth: '32px',
            borderRadius: '100%',
            background: '#0a0a0a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span style={{ color: 'white', fontSize: '11px', fontWeight: 600, lineHeight: 1 }}>
            {getInitials(guest)}
          </span>
        </div>
        <p style={{ fontSize: '15px', fontWeight: 600, color: '#0a0a0a' }}>{guest}</p>
      </div>

      {/* Position text */}
      <p style={{ fontSize: '15px', color: '#404040', lineHeight: 1.7 }}>{position}</p>

      {/* Limited context warning */}
      {!relevant && (
        <p style={{ fontSize: '12px', color: '#737373', marginTop: '0.75rem', fontStyle: 'italic' }}>
          Limited context on this topic
        </p>
      )}
    </div>
  )
}

// ── Dark section card ─────────────────────────────────────────────────────────

function DarkCard({ label, text }: { label: string; text: string }) {
  return (
    <div
      style={{
        background: '#111111',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '16px',
        padding: '1.5rem',
        fontFamily: FONT,
      }}
    >
      <p style={LABEL_STYLE}>{label}</p>
      <p style={{ color: 'rgba(255,255,255,0.85)', fontSize: '15px', lineHeight: 1.7 }}>{text}</p>
    </div>
  )
}

// ── Loading shimmer ───────────────────────────────────────────────────────────

function DebateShimmer() {
  return (
    <div className="space-y-4">
      <p
        style={{
          textAlign: 'center',
          color: 'rgba(255,255,255,0.5)',
          fontSize: '14px',
          fontFamily: FONT,
          paddingBottom: '0.5rem',
        }}
      >
        Preparing the debate…
      </p>

      {/* Combatants row shimmer */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="bg-white rounded-2xl p-6"
            style={{ border: '1px solid rgba(0,0,0,0.08)' }}
          >
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full animate-shimmer-light shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3 animate-shimmer-light rounded-full w-2/5" />
                <div className="h-2.5 animate-shimmer-light rounded-full w-3/5" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Agreement shimmer */}
      <div
        className="rounded-2xl p-6 space-y-2"
        style={{ background: '#111111', border: '1px solid rgba(255,255,255,0.08)' }}
      >
        <div className="h-2 animate-shimmer-light rounded-full w-1/4" style={{ opacity: 0.3 }} />
        <div className="h-3 animate-shimmer-light rounded-full" style={{ opacity: 0.15 }} />
        <div className="h-3 animate-shimmer-light rounded-full w-5/6" style={{ opacity: 0.15 }} />
      </div>

      {/* Positions shimmer */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="bg-white rounded-2xl p-6 space-y-3"
            style={{ border: '1px solid rgba(0,0,0,0.08)' }}
          >
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full animate-shimmer-light shrink-0" />
              <div className="h-3 animate-shimmer-light rounded-full w-1/3" />
            </div>
            <div className="space-y-2">
              <div className="h-2.5 animate-shimmer-light rounded-full" />
              <div className="h-2.5 animate-shimmer-light rounded-full w-5/6" />
              <div className="h-2.5 animate-shimmer-light rounded-full w-4/5" />
              <div className="h-2.5 animate-shimmer-light rounded-full w-3/4" />
            </div>
          </div>
        ))}
      </div>

      {/* Disagreement + bottom line shimmer */}
      {[0, 1].map((i) => (
        <div
          key={i}
          className="rounded-2xl p-6 space-y-2"
          style={{ background: '#111111', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <div className="h-2 animate-shimmer-light rounded-full w-1/3" style={{ opacity: 0.3 }} />
          <div className="h-3 animate-shimmer-light rounded-full" style={{ opacity: 0.15 }} />
          <div className="h-3 animate-shimmer-light rounded-full w-4/5" style={{ opacity: 0.15 }} />
        </div>
      ))}
    </div>
  )
}

// ── Error card ────────────────────────────────────────────────────────────────

function ErrorCard({ message }: { message: string }) {
  return (
    <div
      style={{
        background: '#111111',
        border: '1px solid rgba(255,80,80,0.2)',
        borderRadius: '16px',
        padding: '1.25rem 1.5rem',
        fontFamily: FONT,
      }}
    >
      <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '14px' }}>{message}</p>
    </div>
  )
}

// ── Debate results ────────────────────────────────────────────────────────────

function DebateResults({ result }: { result: DebateApiResponse }) {
  return (
    <div className="space-y-4">
      {/* Combatants */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <CombatantCard guest={result.guest1} source={result.guest1_source} />
        <CombatantCard guest={result.guest2} source={result.guest2_source} />
      </div>

      {/* Where they agree */}
      <DarkCard label="Where They Agree" text={result.agreement} />

      {/* Positions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <PositionCard
          guest={result.guest1}
          position={result.guest1_position}
          relevant={result.guest1_relevant}
        />
        <PositionCard
          guest={result.guest2}
          position={result.guest2_position}
          relevant={result.guest2_relevant}
        />
      </div>

      {/* Core disagreement */}
      <DarkCard label="The Sharpest Disagreement" text={result.core_disagreement} />

      {/* Bottom line — uses gradient like synthesis card */}
      <div
        style={{
          background: 'linear-gradient(135deg, #0f0f0f 0%, #181818 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '16px',
          padding: '1.5rem',
          fontFamily: FONT,
        }}
      >
        <p style={LABEL_STYLE}>Bottom Line</p>
        <p style={{ color: 'white', fontSize: '15px', fontWeight: 500, lineHeight: 1.6 }}>
          {result.bottom_line}
        </p>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DebatePage() {
  const [guests, setGuests] = useState<string[]>([])
  const [guest1, setGuest1] = useState('')
  const [guest2, setGuest2] = useState('')
  const [topics, setTopics] = useState<string[]>([])
  const [topicsLoading, setTopicsLoading] = useState(false)
  const [selectedTopic, setSelectedTopic] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<DebateApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Load guest list on mount; pre-fill from URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const g1 = params.get('guest1')
    const g2 = params.get('guest2')
    if (g1) setGuest1(g1)
    if (g2) setGuest2(g2)
    // Clear params from URL without reload
    if (g1 || g2) {
      const url = new URL(window.location.href)
      url.searchParams.delete('guest1')
      url.searchParams.delete('guest2')
      window.history.replaceState({}, '', url.toString())
    }

    fetch('/api/guests')
      .then((r) => r.json())
      .then((d: { guests?: string[] }) => setGuests(d.guests ?? []))
      .catch(() => {})
  }, [])

  // Fetch shared topics whenever both guests are valid; clear stale results immediately
  useEffect(() => {
    setSelectedTopic('')
    setTopics([])
    setResult(null)
    setError(null)
    const g1ok = guest1 !== '' && guests.includes(guest1)
    const g2ok = guest2 !== '' && guests.includes(guest2)
    if (!g1ok || !g2ok || guest1 === guest2) return
    let cancelled = false
    setTopicsLoading(true)
    fetch(`/api/debate?guest1=${encodeURIComponent(guest1)}&guest2=${encodeURIComponent(guest2)}`)
      .then((r) => r.json())
      .then((d: { topics?: string[] }) => {
        if (!cancelled) setTopics(d.topics ?? [])
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTopicsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [guest1, guest2, guests])

  const guest1Valid = guest1 !== '' && guests.includes(guest1)
  const guest2Valid = guest2 !== '' && guests.includes(guest2)
  const canDebate =
    guest1Valid && guest2Valid && guest1 !== guest2 && selectedTopic !== '' && !loading

  async function handleDebate() {
    if (!canDebate) return
    setLoading(true)
    setResult(null)
    setError(null)
    try {
      const res = await fetch('/api/debate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: selectedTopic, guest1, guest2 }),
      })
      const data = (await res.json()) as Record<string, unknown>
      if (!res.ok) {
        setError((data.error as string) ?? 'Something went wrong.')
      } else {
        setResult(data as unknown as DebateApiResponse)
      }
    } catch {
      setError('Network error — please check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  const hasResult = Boolean(result || error || loading)

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', fontFamily: FONT }}>

      {/* ── Sticky header ── */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          background: 'rgba(10,10,10,0.95)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <div
          style={{
            maxWidth: '860px',
            margin: '0 auto',
            padding: '0.875rem 2rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Link href="/" style={{ lineHeight: 1, display: 'flex' }}>
            <span style={{ fontSize: '20px', fontWeight: 600, color: 'white', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', letterSpacing: '-0.01em' }}>Chorus</span>
          </Link>
          <Link
            href="/"
            style={{
              color: 'rgba(255,255,255,0.5)',
              fontSize: '14px',
              textDecoration: 'none',
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => ((e.target as HTMLElement).style.color = 'white')}
            onMouseLeave={(e) =>
              ((e.target as HTMLElement).style.color = 'rgba(255,255,255,0.5)')
            }
          >
            ← Ask a question
          </Link>
        </div>
      </header>

      {/* ── Main ── */}
      <main style={{ maxWidth: '860px', margin: '0 auto', padding: '3rem 2rem 5rem' }}>

        {/* Hero — hide once results are showing */}
        {!hasResult && (
          <div style={{ marginBottom: '2.5rem', textAlign: 'center' }}>
            <h1
              style={{
                color: 'white',
                fontSize: '32px',
                fontWeight: 700,
                lineHeight: 1.2,
                marginBottom: '0.5rem',
              }}
            >
              Guest vs Guest
            </h1>
            <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '16px', lineHeight: 1.5 }}>
              See where the experts agree — and where they don&rsquo;t
            </p>
          </div>
        )}

        {/* ── Guest selectors ── */}
        <div className="flex flex-col sm:flex-row gap-4" style={{ marginBottom: '1rem' }}>
          <GuestInput
            label="Guest 1"
            value={guest1}
            onChange={setGuest1}
            guests={guests}
            excludeGuest={guest2}
          />
          <GuestInput
            label="Guest 2"
            value={guest2}
            onChange={setGuest2}
            guests={guests}
            excludeGuest={guest1}
          />
        </div>

        {/* ── Topic chips ── */}
        {(topicsLoading || topics.length > 0) && (
          <div style={{ marginBottom: '2rem' }}>
            {topicsLoading ? (
              <p
                style={{
                  color: 'rgba(255,255,255,0.4)',
                  fontSize: '13px',
                  fontFamily: FONT,
                  marginBottom: '0.75rem',
                }}
              >
                Finding shared topics…
              </p>
            ) : (
              <p
                style={{
                  color: 'rgba(255,255,255,0.4)',
                  fontSize: '11px',
                  fontWeight: 600,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  fontFamily: FONT,
                  marginBottom: '0.75rem',
                }}
              >
                Shared Topics
              </p>
            )}

            {!topicsLoading && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {topics.map((topic) => {
                  const active = selectedTopic === topic
                  return (
                    <button
                      key={topic}
                      onClick={() => setSelectedTopic(active ? '' : topic)}
                      style={{
                        background: active ? 'white' : 'rgba(255,255,255,0.08)',
                        color: active ? '#0a0a0a' : 'rgba(255,255,255,0.75)',
                        border: active ? '1px solid white' : '1px solid rgba(255,255,255,0.12)',
                        borderRadius: '100px',
                        padding: '0.45rem 1rem',
                        fontSize: '13px',
                        fontWeight: active ? 600 : 400,
                        cursor: 'pointer',
                        fontFamily: FONT,
                        transition: 'background 0.15s, color 0.15s',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {topic}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Debate button — only visible once a topic is selected ── */}
        {selectedTopic && (
          <div style={{ marginBottom: '2rem' }}>
            <button
              onClick={handleDebate}
              disabled={!canDebate}
              style={{
                background: 'white',
                color: '#0a0a0a',
                border: 'none',
                borderRadius: '12px',
                padding: '0.875rem 2rem',
                fontSize: '15px',
                fontWeight: 600,
                cursor: canDebate ? 'pointer' : 'not-allowed',
                opacity: canDebate ? 1 : 0.4,
                fontFamily: FONT,
                transition: 'opacity 0.15s',
              }}
            >
              Debate
            </button>
          </div>
        )}

        {/* ── Content area ── */}
        {loading && <DebateShimmer />}
        {!loading && error && <ErrorCard message={error} />}
        {!loading && result && <DebateResults result={result} />}
      </main>
    </div>
  )
}
