'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import type { MentalModel, MentalModelsApiResponse, MentalModelGuest } from '../api/mental-models/route'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/)
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

// ── Skeleton card ─────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div
      className="bg-white rounded-2xl p-6 space-y-4"
      style={{ border: '1px solid rgba(0,0,0,0.08)' }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="h-4 animate-shimmer-light rounded-full w-2/5" />
        <div className="h-6 animate-shimmer-light rounded-full w-16" />
      </div>
      <div className="flex gap-2 flex-wrap">
        <div className="h-7 animate-shimmer-light rounded-full w-20" />
        <div className="h-7 animate-shimmer-light rounded-full w-24" />
        <div className="h-7 animate-shimmer-light rounded-full w-18" />
      </div>
    </div>
  )
}

function LoadingGrid() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '1.5rem',
      }}
      className="mental-models-grid"
    >
      {Array.from({ length: 9 }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  )
}

// ── Expanded guest list ───────────────────────────────────────────────────────

function GuestList({ guests }: { guests: MentalModelGuest[] }) {
  return (
    <div
      style={{
        marginTop: '1rem',
        paddingTop: '1rem',
        borderTop: '1px solid rgba(0,0,0,0.07)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.6rem',
      }}
    >
      {guests.map((g, i) => (
        <a
          key={i}
          href={g.youtube_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.625rem',
            textDecoration: 'none',
            padding: '0.375rem 0',
          }}
          className="group"
        >
          {/* Avatar */}
          <div
            style={{
              width: '28px',
              height: '28px',
              minWidth: '28px',
              borderRadius: '100px',
              background: '#0a0a0a',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <span style={{ color: 'white', fontSize: '10px', fontWeight: 600, lineHeight: 1 }}>
              {getInitials(g.guest)}
            </span>
          </div>

          {/* Text */}
          <div style={{ minWidth: 0 }}>
            <p
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: '#0a0a0a',
                lineHeight: 1.3,
              }}
            >
              {g.guest}
            </p>
            <p
              className="truncate group-hover:underline"
              style={{
                fontSize: '12px',
                color: '#737373',
                marginTop: '1px',
                textDecoration: 'none',
              }}
            >
              {g.title}
            </p>
          </div>

          {/* Arrow */}
          <span
            style={{
              marginLeft: 'auto',
              fontSize: '12px',
              color: '#c0c0c0',
              flexShrink: 0,
            }}
          >
            ↗
          </span>
        </a>
      ))}
    </div>
  )
}

// ── Model card ────────────────────────────────────────────────────────────────

const MAX_CHIPS = 5

function ModelCard({ model }: { model: MentalModel }) {
  const [expanded, setExpanded] = useState(false)
  const visibleChips = model.guests.slice(0, MAX_CHIPS)
  const overflow = model.guests.length - MAX_CHIPS

  return (
    <div
      onClick={() => setExpanded((e) => !e)}
      style={{
        background: '#ffffff',
        border: '1px solid rgba(0,0,0,0.08)',
        borderRadius: '16px',
        padding: '1.5rem',
        cursor: 'pointer',
        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)'
        ;(e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)'
        ;(e.currentTarget as HTMLDivElement).style.boxShadow = 'none'
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          marginBottom: '0.875rem',
        }}
      >
        <p
          style={{
            fontSize: '17px',
            fontWeight: 600,
            color: '#0a0a0a',
            lineHeight: 1.3,
            flex: 1,
            minWidth: 0,
          }}
        >
          {model.name}
        </p>
        <span
          style={{
            background: '#f5f5f5',
            borderRadius: '100px',
            padding: '0.25rem 0.75rem',
            fontSize: '12px',
            color: '#737373',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {model.count} {model.count === 1 ? 'guest' : 'guests'}
        </span>
      </div>

      {/* Guest chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
        {visibleChips.map((g, i) => (
          <span
            key={i}
            style={{
              background: '#0a0a0a',
              color: 'white',
              borderRadius: '100px',
              padding: '0.3rem 0.75rem',
              fontSize: '12px',
              fontWeight: 500,
              whiteSpace: 'nowrap',
            }}
          >
            {g.guest}
          </span>
        ))}
        {overflow > 0 && (
          <span
            style={{
              background: '#f5f5f5',
              color: '#737373',
              borderRadius: '100px',
              padding: '0.3rem 0.75rem',
              fontSize: '12px',
              fontWeight: 500,
              whiteSpace: 'nowrap',
            }}
          >
            +{overflow} more
          </span>
        )}
      </div>

      {/* Expanded guest list */}
      {expanded && <GuestList guests={model.guests} />}

      {/* Expand / collapse cue */}
      <div
        style={{
          marginTop: '0.875rem',
          fontSize: '12px',
          color: '#b0b0b0',
          userSelect: 'none',
        }}
      >
        {expanded ? '▲ Show less' : '▼ See episodes'}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MentalModelsPage() {
  const [data, setData] = useState<MentalModelsApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/mental-models')
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setError(d.error)
        } else {
          setData(d as MentalModelsApiResponse)
        }
      })
      .catch(() => setError('Could not load mental models'))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    if (!data) return []
    const q = search.trim().toLowerCase()
    if (!q) return data.models
    return data.models.filter((m) => m.name.toLowerCase().includes(q))
  }, [data, search])

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a' }}>

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
              maxWidth: '1200px',
              margin: '0 auto',
              padding: '0.875rem 2rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span
              style={{
                color: 'white',
                fontSize: '20px',
                lineHeight: 1,
                fontFamily: 'var(--font-dm-serif)',
              }}
            >
              Chorus
            </span>
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

        {/* ── Main content ── */}
        <main
          style={{
            maxWidth: '1200px',
            margin: '0 auto',
            padding: '3rem 2rem 5rem',
          }}
        >
          {/* Hero */}
          <div style={{ marginBottom: '2.5rem' }}>
            <h1
              style={{
                color: 'white',
                fontSize: '32px',
                fontWeight: 700,
                lineHeight: 1.2,
                marginBottom: '0.5rem',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
              }}
            >
              Mental Model Library
            </h1>
            <p
              style={{
                color: 'rgba(255,255,255,0.5)',
                fontSize: '16px',
                lineHeight: 1.5,
              }}
            >
              {data
                ? `${data.total_models} mental models across ${data.total_episodes} episodes`
                : loading
                ? 'Loading…'
                : ''}
            </p>
          </div>

          {/* Search + count row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              marginBottom: '2rem',
              flexWrap: 'wrap',
            }}
          >
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search mental models…"
              style={{
                flex: '1 1 0',
                maxWidth: '600px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: '12px',
                padding: '0.875rem 1.25rem',
                color: 'white',
                fontSize: '15px',
                outline: 'none',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
              }}
              onFocus={(e) => {
                e.target.style.borderColor = 'rgba(255,255,255,0.4)'
              }}
              onBlur={(e) => {
                e.target.style.borderColor = 'rgba(255,255,255,0.12)'
              }}
            />
            {!loading && data && (
              <span
                style={{
                  background: 'rgba(255,255,255,0.1)',
                  color: 'white',
                  borderRadius: '100px',
                  padding: '0.3rem 0.875rem',
                  fontSize: '13px',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                }}
              >
                {filtered.length} {filtered.length === 1 ? 'model' : 'models'}
              </span>
            )}
          </div>

          {/* Content */}
          {loading && <LoadingGrid />}

          {!loading && error && (
            <div
              style={{
                textAlign: 'center',
                padding: '4rem 0',
                color: 'rgba(255,255,255,0.5)',
                fontSize: '16px',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
              }}
            >
              Could not load mental models
            </div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div
              style={{
                textAlign: 'center',
                padding: '4rem 0',
                color: 'rgba(255,255,255,0.4)',
                fontSize: '15px',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
              }}
            >
              No models match &ldquo;{search}&rdquo;
            </div>
          )}

          {!loading && !error && filtered.length > 0 && (
            <div
              className="mental-models-grid"
              style={{
                display: 'grid',
                gap: '1.5rem',
              }}
            >
              {filtered.map((model) => (
                <ModelCard key={model.name} model={model} />
              ))}
            </div>
          )}
        </main>
    </div>
  )
}
