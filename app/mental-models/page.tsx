'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import type { MentalModel, MentalModelsApiResponse } from '../api/mental-models/route'
import type { ModelDetail } from '../api/mental-model-detail/route'

// ── Constants ─────────────────────────────────────────────────────────────────

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const HEADER_H = 56

const SITUATION_CHIPS = [
  'Prioritization', 'Growth',
  'Hiring',         'Strategy',
  'Leadership',     '0→1',
] as const

const THEME_KEYWORDS: Record<string, string[]> = {
  Prioritization: [
    'prioriti', 'roadmap', 'backlog', 'focus',
    'tradeoff', 'ruthless', 'sequenc', 'say no',
    'stack rank', 'ice', 'rice', 'impact',
    'effort', 'value', 'urgent', 'important',
    'queue', 'scope', 'cut', 'defer',
  ],
  Growth: [
    'growth', 'acqui', 'retent', 'viral',
    'referral', 'activat', 'funnel', 'north star',
    'metric', 'PLG', 'product-led', 'loop',
    'flywheel', 'conversion', 'churn', 'expand',
    'monetiz', 'revenue', 'DAU', 'MAU', 'engage',
  ],
  Hiring: [
    'hiring', 'recruit', 'interview', 'onboard',
    'team', 'culture', 'performance', 'firing',
    'manager', 'org', 'talent', 'candidate',
    'headcount', 'skill', 'bar raiser', 'ramp',
  ],
  Strategy: [
    'strateg', 'vision', 'position', 'moat',
    'competit', 'market', 'pric', 'platform',
    'differenti', 'bet', 'mission', 'north star',
    'long-term', 'invest', 'portfolio', 'category',
  ],
  Leadership: [
    'leadership', 'influence', 'stakeholder',
    'communicat', 'trust', 'feedback', 'align',
    'execut', 'manage up', 'narrative', 'buy-in',
    'credib', 'persuad', 'present', 'conflict',
  ],
  '0→1': [
    'PMF', 'product-market', 'MVP', 'early stage',
    'founder', 'launch', 'validat', 'zero to one',
    'startup', 'discover', 'hypothesis', 'experiment',
    'beachhead', 'ICP', 'first customer', 'v1',
  ],
}

type Mode = 'situation' | 'guest'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/)
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

/** Check if a model matches any of the given keywords (against model name + guest names) */
function modelMatchesKeywords(model: MentalModel, keywords: string[]): boolean {
  const nameLower = model.name.toLowerCase()
  const guestNames = model.guests.map((g) => g.guest.toLowerCase()).join(' ')
  const searchable = nameLower + ' ' + guestNames
  for (const kw of keywords) {
    if (searchable.includes(kw.toLowerCase())) return true
  }
  return false
}

// ── Mode toggle ───────────────────────────────────────────────────────────────

function ModeToggle({
  mode,
  onChange,
}: {
  mode: Mode
  onChange: (m: Mode) => void
}) {
  return (
    <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
      {(['situation', 'guest'] as const).map((m) => {
        const active = mode === m
        return (
          <button
            key={m}
            onClick={() => onChange(m)}
            style={{
              width: '50%',
              textAlign: 'center',
              padding: '0.875rem 0',
              fontSize: '13px',
              fontFamily: FONT,
              background: 'transparent',
              border: 'none',
              borderBottom: active ? '2px solid white' : '2px solid transparent',
              color: active ? 'white' : 'rgba(255,255,255,0.4)',
              fontWeight: active ? 500 : 400,
              cursor: 'pointer',
              transition: 'color 0.15s',
            }}
          >
            {m === 'situation' ? 'For your situation' : 'By guest'}
          </button>
        )
      })}
    </div>
  )
}

// ── Left panel list item (reused) ─────────────────────────────────────────────

function ListItem({
  model,
  active,
  onClick,
}: {
  model: { name: string; count: number }
  active: boolean
  onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '0.875rem 1rem',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        borderLeft: active ? '2px solid white' : '2px solid transparent',
        cursor: 'pointer',
        background: active
          ? 'rgba(255,255,255,0.08)'
          : hovered
          ? 'rgba(255,255,255,0.05)'
          : 'transparent',
        transition: 'background 0.1s',
        fontFamily: FONT,
      }}
    >
      <p
        style={{
          fontSize: '14px',
          fontWeight: active ? 500 : 400,
          color: active ? 'white' : 'rgba(255,255,255,0.85)',
          lineHeight: 1.4,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          margin: 0,
        }}
      >
        {model.name}
      </p>
      <p
        style={{
          fontSize: '12px',
          color: 'rgba(255,255,255,0.35)',
          marginTop: '2px',
          margin: '2px 0 0',
        }}
      >
        {model.count} {model.count === 1 ? 'guest' : 'guests'}
      </p>
    </div>
  )
}

// ── Guest list item ───────────────────────────────────────────────────────────

function GuestListItem({
  name,
  frameworkCount,
  active,
  onClick,
}: {
  name: string
  frameworkCount: number
  active: boolean
  onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.875rem 1rem',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        borderLeft: active ? '2px solid white' : '2px solid transparent',
        cursor: 'pointer',
        background: active
          ? 'rgba(255,255,255,0.08)'
          : hovered
          ? 'rgba(255,255,255,0.05)'
          : 'transparent',
        transition: 'background 0.1s',
        fontFamily: FONT,
      }}
    >
      <div
        style={{
          width: '32px',
          height: '32px',
          minWidth: '32px',
          borderRadius: '100%',
          background: '#1a1a1a',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <span style={{ color: 'white', fontSize: '11px', fontWeight: 600, lineHeight: 1 }}>
          {getInitials(name)}
        </span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontSize: '14px',
            fontWeight: active ? 500 : 400,
            color: active ? 'white' : 'rgba(255,255,255,0.85)',
            lineHeight: 1.4,
            margin: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </p>
        <p
          style={{
            fontSize: '12px',
            color: 'rgba(255,255,255,0.35)',
            margin: '2px 0 0',
          }}
        >
          {frameworkCount === 0
            ? 'No frameworks'
            : `${frameworkCount} ${frameworkCount === 1 ? 'framework' : 'frameworks'}`}
        </p>
      </div>
    </div>
  )
}

// ── Right panel: Model detail (reused) ────────────────────────────────────────

function ModelDetailPanel({
  model,
  detail,
  detailLoading,
  onGenerate,
  onBack,
  backLabel,
  showBackBtn,
}: {
  model: MentalModel | null
  detail: ModelDetail | null
  detailLoading: boolean
  onGenerate: () => void
  onBack: () => void
  backLabel: string
  showBackBtn: boolean
}) {
  if (!model) return null

  return (
    <div style={{ fontFamily: FONT }}>
      {showBackBtn && (
        <button
          onClick={onBack}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'rgba(255,255,255,0.5)',
            fontSize: '14px',
            cursor: 'pointer',
            padding: '0 0 1.5rem 0',
            fontFamily: FONT,
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'white')}
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.5)')
          }
        >
          {backLabel}
        </button>
      )}

      <h1
        style={{
          fontSize: '28px',
          fontWeight: 600,
          color: 'white',
          lineHeight: 1.3,
          marginBottom: '0.5rem',
          marginTop: 0,
        }}
      >
        {model.name}
      </h1>
      <p
        style={{
          fontSize: '14px',
          color: 'rgba(255,255,255,0.4)',
          marginBottom: '1.25rem',
          marginTop: 0,
        }}
      >
        {model.count} {model.count === 1 ? 'guest' : 'guests'}
      </p>

      {/* Guest chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '1.5rem' }}>
        {model.guests.map((g, i) => (
          <span
            key={i}
            style={{
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: 'rgba(255,255,255,0.8)',
              borderRadius: '100px',
              padding: '0.3rem 0.85rem',
              fontSize: '13px',
              whiteSpace: 'nowrap',
            }}
          >
            {g.guest}
          </span>
        ))}
      </div>

      {/* Episode list */}
      <div style={{ marginBottom: '1.5rem' }}>
        {model.guests.map((g, i) => (
          <a
            key={i}
            href={g.youtube_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              textDecoration: 'none',
              padding: '0.625rem 0',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget.querySelector<HTMLElement>('.ep-title')
              if (el) el.style.color = 'white'
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget.querySelector<HTMLElement>('.ep-title')
              if (el) el.style.color = 'rgba(255,255,255,0.7)'
            }}
          >
            <div
              style={{
                width: '32px',
                height: '32px',
                minWidth: '32px',
                borderRadius: '100%',
                background: '#1a1a1a',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <span style={{ color: 'white', fontSize: '11px', fontWeight: 600, lineHeight: 1 }}>
                {getInitials(g.guest)}
              </span>
            </div>
            <span
              className="ep-title"
              style={{
                flex: 1,
                fontSize: '14px',
                color: 'rgba(255,255,255,0.7)',
                lineHeight: 1.4,
                minWidth: 0,
                transition: 'color 0.15s',
              }}
            >
              {g.title}
            </span>
            <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '14px', flexShrink: 0 }}>
              ↗
            </span>
          </a>
        ))}
      </div>

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginBottom: '1.5rem' }} />

      {/* Generate insight / loading / enriched content */}
      {detailLoading ? (
        <p
          className="animate-pulse-subtle"
          style={{ color: 'rgba(255,255,255,0.4)', fontSize: '14px', fontFamily: FONT }}
        >
          Generating insight…
        </p>
      ) : !detail ? (
        <button
          onClick={onGenerate}
          style={{
            background: 'white',
            color: '#0a0a0a',
            border: 'none',
            borderRadius: '100px',
            padding: '0.75rem 2rem',
            fontSize: '14px',
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: FONT,
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.9)')
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.background = 'white')
          }
        >
          Generate insight
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div>
            <p
              style={{
                fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)',
                marginBottom: '0.5rem', marginTop: 0,
              }}
            >
              What It Is
            </p>
            <p
              style={{
                fontSize: '15px', color: 'rgba(255,255,255,0.85)', lineHeight: 1.75,
                wordBreak: 'break-word', overflowWrap: 'break-word', margin: 0,
              }}
            >
              {detail.explanation}
            </p>
          </div>

          <div>
            <p
              style={{
                fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)',
                marginBottom: '0.5rem', marginTop: 0,
              }}
            >
              When to Use
            </p>
            <p
              style={{
                fontSize: '14px', fontStyle: 'italic', color: 'rgba(255,255,255,0.7)',
                lineHeight: 1.7, wordBreak: 'break-word', overflowWrap: 'break-word', margin: 0,
              }}
            >
              {detail.when_to_use}
            </p>
          </div>

          {detail.guest_takes.length > 0 && (
            <div>
              <p
                style={{
                  fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
                  textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)',
                  marginBottom: '0.75rem', marginTop: 0,
                }}
              >
                Perspectives
              </p>
              <div>
                {detail.guest_takes.map((gt, i) => (
                  <div
                    key={i}
                    style={{ padding: '0.75rem 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
                  >
                    <p
                      style={{
                        fontSize: '14px', fontWeight: 600, color: 'white',
                        marginBottom: '0.25rem', marginTop: 0,
                      }}
                    >
                      {gt.guest}
                    </p>
                    <p
                      style={{
                        fontSize: '14px', color: 'rgba(255,255,255,0.7)', lineHeight: 1.6,
                        wordBreak: 'break-word', overflowWrap: 'break-word', margin: 0,
                      }}
                    >
                      {gt.take}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <p
              style={{
                fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)',
                marginBottom: '0.5rem', marginTop: 0,
              }}
            >
              Tensions With
            </p>
            <p
              style={{
                fontSize: '14px', color: 'rgba(255,255,255,0.65)', lineHeight: 1.7,
                wordBreak: 'break-word', overflowWrap: 'break-word', margin: 0,
              }}
            >
              {detail.tensions}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Right panel: Guest detail ─────────────────────────────────────────────────

function GuestDetailPanel({
  guestName,
  guestModels,
  guestEpisodes,
  onModelClick,
  onBack,
  showBackBtn,
}: {
  guestName: string
  guestModels: string[]
  guestEpisodes: { title: string; youtube_url: string; guest_context: Record<string, string> | null }[]
  onModelClick: (modelName: string) => void
  onBack: () => void
  showBackBtn: boolean
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  // Get first guest_context subtitle
  const subtitle = useMemo(() => {
    for (const ep of guestEpisodes) {
      if (ep.guest_context) {
        const vals = Object.values(ep.guest_context)
        if (vals.length > 0) return vals[0]
      }
    }
    return null
  }, [guestEpisodes])

  return (
    <div style={{ fontFamily: FONT }}>
      {showBackBtn && (
        <button
          onClick={onBack}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'rgba(255,255,255,0.5)',
            fontSize: '14px',
            cursor: 'pointer',
            padding: '0 0 1.5rem 0',
            fontFamily: FONT,
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'white')}
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.5)')
          }
        >
          ← Guests
        </button>
      )}

      <h1
        style={{
          fontSize: '28px',
          fontWeight: 600,
          color: 'white',
          lineHeight: 1.3,
          marginBottom: subtitle ? '0.25rem' : '1.25rem',
          marginTop: 0,
        }}
      >
        {guestName}
      </h1>
      {subtitle && (
        <p
          style={{
            fontSize: '14px',
            color: 'rgba(255,255,255,0.4)',
            marginBottom: '1.25rem',
            marginTop: 0,
          }}
        >
          {subtitle}
        </p>
      )}

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginBottom: '1.5rem' }} />

      {/* FRAMEWORKS label */}
      <p
        style={{
          fontSize: '11px',
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.4)',
          marginBottom: '0.75rem',
          marginTop: 0,
        }}
      >
        Frameworks
      </p>

      {/* Model list */}
      {guestModels.length === 0 ? (
        <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: '14px', margin: 0 }}>
          No frameworks found for this guest.
        </p>
      ) : (
        <div>
          {guestModels.map((name, i) => (
            <div
              key={name}
              onClick={() => onModelClick(name)}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.75rem 0',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  fontSize: '15px',
                  color: hoveredIdx === i ? 'white' : 'rgba(255,255,255,0.8)',
                  transition: 'color 0.15s',
                }}
              >
                {name}
              </span>
              <span
                style={{
                  fontSize: '14px',
                  color: 'rgba(255,255,255,0.3)',
                  opacity: hoveredIdx === i ? 1 : 0,
                  transition: 'opacity 0.15s',
                  flexShrink: 0,
                  marginLeft: '0.5rem',
                }}
              >
                →
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Episode links */}
      {guestEpisodes.length > 0 && (
        <div style={{ marginTop: '1.5rem' }}>
          {guestEpisodes.map((ep, i) => (
            <a
              key={i}
              href={ep.youtube_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'block',
                color: 'rgba(255,255,255,0.5)',
                fontSize: '13px',
                textDecoration: 'none',
                padding: '0.25rem 0',
                transition: 'color 0.15s',
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'white')}
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.5)')
              }
            >
              Watch episode ↗
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MentalModelsPage() {
  // Shared state
  const [mode, setMode] = useState<Mode>('situation')
  const [allData, setAllData] = useState<MentalModelsApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailCache, setDetailCache] = useState<Record<string, ModelDetail>>({})
  const [detailLoading, setDetailLoading] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [mobileShowList, setMobileShowList] = useState(true)

  // Mode 1 — Situation (all models shown by default, chips as filters)
  const [selectedChip, setSelectedChip] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedModel, setSelectedModel] = useState<MentalModel | null>(null)

  // Mode 2 — Guest
  const [guestSearch, setGuestSearch] = useState('')
  const [selectedGuest, setSelectedGuest] = useState<string | null>(null)

  // Detect mobile
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Load all mental models data
  useEffect(() => {
    fetch('/api/mental-models')
      .then((r) => r.json())
      .then((d) => {
        if (!d.error) setAllData(d as MentalModelsApiResponse)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Filtered models for Mode 1 — client-side filtering
  const filteredModels = useMemo(() => {
    if (!allData) return []
    let models = allData.models

    // Apply chip filter (keyword matching on model name + guest names)
    if (selectedChip) {
      const keywords = THEME_KEYWORDS[selectedChip]
      if (keywords) {
        models = models.filter((m) => modelMatchesKeywords(m, keywords))
      }
    }

    // Apply search filter
    const q = search.trim().toLowerCase()
    if (q) {
      models = models.filter((m) => m.name.toLowerCase().includes(q))
    }

    return models
  }, [allData, selectedChip, search])

  // Derive guest → models mapping from allData
  const guestModelMap = useMemo(() => {
    if (!allData) return new Map<string, { models: string[]; episodes: { title: string; youtube_url: string; guest_context: Record<string, string> | null }[] }>()
    const map = new Map<string, { models: Set<string>; episodes: Map<string, { title: string; youtube_url: string; guest_context: Record<string, string> | null }> }>()

    for (const model of allData.models) {
      for (const g of model.guests) {
        let entry = map.get(g.guest)
        if (!entry) {
          entry = { models: new Set(), episodes: new Map() }
          map.set(g.guest, entry)
        }
        entry.models.add(model.name)
        if (!entry.episodes.has(g.title)) {
          entry.episodes.set(g.title, { title: g.title, youtube_url: g.youtube_url, guest_context: g.guest_context })
        }
      }
    }

    // Convert to final form
    const result = new Map<string, { models: string[]; episodes: { title: string; youtube_url: string; guest_context: Record<string, string> | null }[] }>()
    for (const [name, entry] of map) {
      result.set(name, {
        models: Array.from(entry.models),
        episodes: Array.from(entry.episodes.values()),
      })
    }
    return result
  }, [allData])

  // All guest names sorted, guests with frameworks first
  const allGuests = useMemo(() => {
    const names = Array.from(guestModelMap.keys())
    return names.sort((a, b) => {
      const ac = guestModelMap.get(a)?.models.length ?? 0
      const bc = guestModelMap.get(b)?.models.length ?? 0
      if (ac === 0 && bc > 0) return 1
      if (bc === 0 && ac > 0) return -1
      return a.localeCompare(b)
    })
  }, [guestModelMap])

  const filteredGuests = useMemo(() => {
    const q = guestSearch.trim().toLowerCase()
    if (!q) return allGuests
    return allGuests.filter((g) => g.toLowerCase().includes(q))
  }, [allGuests, guestSearch])

  function handleChipClick(chip: string) {
    if (selectedChip === chip) {
      setSelectedChip(null)
      return
    }
    setSelectedChip(chip)
  }

  // Generate detail for a model
  async function handleGenerate() {
    if (!selectedModel) return
    const name = selectedModel.name
    if (detailCache[name]) return
    setDetailLoading(true)
    try {
      const res = await fetch('/api/mental-model-detail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_name: name }),
      })
      const detail = (await res.json()) as ModelDetail
      setDetailCache((prev) => ({ ...prev, [name]: detail }))
    } catch {
      // button stays for retry
    } finally {
      setDetailLoading(false)
    }
  }

  // Select model from situation list
  function handleSelectModel(m: MentalModel) {
    setSelectedModel(m)
    if (isMobile) setMobileShowList(false)
  }

  // FIX 1: Click model from guest detail — do NOT change mode
  function handleGuestModelClick(modelName: string) {
    const found = allData?.models.find((m) => m.name === modelName) ?? null
    if (found) {
      setSelectedModel(found)
      if (isMobile) setMobileShowList(false)
    }
  }

  const currentDetail = selectedModel ? (detailCache[selectedModel.name] ?? null) : null
  const showLeft = !isMobile || mobileShowList
  const showRight = !isMobile || !mobileShowList

  // Selected guest data
  const selectedGuestData = selectedGuest ? guestModelMap.get(selectedGuest) : null

  return (
    <div
      style={{
        height: '100vh',
        background: '#0a0a0a',
        fontFamily: FONT,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* ── Header ── */}
      <header
        style={{
          position: 'relative',
          zIndex: 10,
          height: `${HEADER_H}px`,
          flexShrink: 0,
          background: '#0a0a0a',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            width: '100%',
            padding: '0 2rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Link href="/" style={{ lineHeight: 1, display: 'flex', textDecoration: 'none' }}>
            <span style={{ fontSize: '20px', fontWeight: 600, color: 'white', fontFamily: FONT, letterSpacing: '-0.01em' }}>Chorus</span>
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

      {/* ── Two-panel body ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ── Left panel ── */}
        {showLeft && (
          <div
            style={{
              width: isMobile ? '100%' : '360px',
              flexShrink: 0,
              background: '#111111',
              borderRight: isMobile ? 'none' : '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              overflowY: 'auto',
              overflowX: 'hidden',
            }}
          >
            {/* Mode toggle — sticky within left panel */}
            <div style={{ position: 'sticky', top: 0, background: '#111111', zIndex: 5 }}>
              <ModeToggle
                mode={mode}
                onChange={(m) => {
                  setMode(m)
                  setSelectedModel(null)
                  setSelectedGuest(null)
                  if (isMobile) setMobileShowList(true)
                }}
              />
            </div>

            {/* ── Mode 1: Situation — all models with chip filters ── */}
            {mode === 'situation' && (
              <>
                <div style={{ padding: '1rem' }}>
                  {/* Search input */}
                  <input
                    suppressHydrationWarning
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search models..."
                    style={{
                      width: '100%',
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '8px',
                      padding: '0.75rem 1rem',
                      color: 'white',
                      fontSize: '13px',
                      outline: 'none',
                      fontFamily: FONT,
                      boxSizing: 'border-box',
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.3)'
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
                    }}
                  />

                  {/* "Filter by topic" label */}
                  <p
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: 'rgba(255,255,255,0.4)',
                      margin: '1rem 0 0.5rem',
                    }}
                  >
                    Filter by topic
                  </p>

                  {/* 2x3 chip grid */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '0.5rem',
                    }}
                  >
                    {SITUATION_CHIPS.map((chip) => {
                      const active = selectedChip === chip
                      return (
                        <button
                          key={chip}
                          onClick={() => handleChipClick(chip)}
                          style={{
                            background: active
                              ? 'rgba(255,255,255,0.12)'
                              : 'rgba(255,255,255,0.06)',
                            border: `1px solid ${
                              active ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)'
                            }`,
                            color: active ? 'white' : 'rgba(255,255,255,0.7)',
                            borderRadius: '8px',
                            padding: '0.75rem 0.5rem',
                            fontSize: '13px',
                            textAlign: 'center',
                            cursor: 'pointer',
                            fontFamily: FONT,
                            width: '100%',
                            transition: 'all 0.15s',
                          }}
                        >
                          {chip}{active ? ' ×' : ''}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* "← All topics" back link when chip is selected */}
                {selectedChip && (
                  <div
                    onClick={() => {
                      setSelectedChip(null)
                      setSelectedModel(null)
                    }}
                    style={{
                      color: 'rgba(255,255,255,0.4)',
                      fontSize: '13px',
                      cursor: 'pointer',
                      padding: '0.75rem 1rem',
                      display: 'block',
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      fontFamily: FONT,
                      transition: 'color 0.15s',
                    }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'white')}
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.4)')
                    }
                  >
                    ← All topics
                  </div>
                )}

                {/* Model count */}
                <div style={{ padding: '0.5rem 1rem 0.25rem' }}>
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', fontFamily: FONT }}>
                    {loading ? '…' : `Showing ${filteredModels.length} models`}
                  </span>
                </div>

                {/* Model list */}
                <div>
                  {loading &&
                    Array.from({ length: 12 }).map((_, i) => (
                      <div
                        key={i}
                        style={{
                          padding: '0.875rem 1rem',
                          borderBottom: '1px solid rgba(255,255,255,0.05)',
                        }}
                      >
                        <div
                          className="animate-shimmer"
                          style={{
                            height: '13px',
                            borderRadius: '4px',
                            width: `${55 + (i % 4) * 10}%`,
                            marginBottom: '6px',
                          }}
                        />
                        <div
                          className="animate-shimmer"
                          style={{ height: '11px', borderRadius: '4px', width: '35%' }}
                        />
                      </div>
                    ))}

                  {!loading &&
                    filteredModels.map((model) => (
                      <ListItem
                        key={model.name}
                        model={model}
                        active={selectedModel?.name === model.name}
                        onClick={() => handleSelectModel(model)}
                      />
                    ))}
                </div>
              </>
            )}

            {/* ── Mode 2: By Guest ── */}
            {mode === 'guest' && (
              <>
                <div style={{ padding: '1rem 1rem 0' }}>
                  <input
                    suppressHydrationWarning
                    type="text"
                    value={guestSearch}
                    onChange={(e) => setGuestSearch(e.target.value)}
                    placeholder="Search guests..."
                    style={{
                      width: '100%',
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '8px',
                      padding: '0.75rem 1rem',
                      color: 'white',
                      fontSize: '13px',
                      outline: 'none',
                      fontFamily: FONT,
                      boxSizing: 'border-box',
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.3)'
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
                    }}
                  />
                </div>

                <div style={{ padding: '0.5rem 1rem 0.75rem' }}>
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', fontFamily: FONT }}>
                    {loading ? '…' : `${filteredGuests.length} guests`}
                  </span>
                </div>

                <div>
                  {loading &&
                    Array.from({ length: 12 }).map((_, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.75rem',
                          padding: '0.875rem 1rem',
                          borderBottom: '1px solid rgba(255,255,255,0.05)',
                        }}
                      >
                        <div
                          className="animate-shimmer"
                          style={{ width: '32px', height: '32px', borderRadius: '100%', flexShrink: 0 }}
                        />
                        <div style={{ flex: 1 }}>
                          <div
                            className="animate-shimmer"
                            style={{
                              height: '13px',
                              borderRadius: '4px',
                              width: `${50 + (i % 3) * 15}%`,
                              marginBottom: '6px',
                            }}
                          />
                          <div
                            className="animate-shimmer"
                            style={{ height: '11px', borderRadius: '4px', width: '40%' }}
                          />
                        </div>
                      </div>
                    ))}

                  {!loading &&
                    filteredGuests.map((guest) => (
                      <GuestListItem
                        key={guest}
                        name={guest}
                        frameworkCount={guestModelMap.get(guest)?.models.length ?? 0}
                        active={selectedGuest === guest}
                        onClick={() => {
                          setSelectedGuest(guest)
                          setSelectedModel(null)
                          if (isMobile) setMobileShowList(false)
                        }}
                      />
                    ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Right panel ── */}
        {showRight && (
          <div
            style={{
              flex: 1,
              background: '#0a0a0a',
              height: '100%',
              overflowY: 'auto',
              overflowX: 'hidden',
              padding: isMobile ? '1.5rem 1.25rem' : '2.5rem 3rem',
            }}
          >
            {/* Mode 1 right panel */}
            {mode === 'situation' && (
              <>
                {!selectedModel ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      height: '100%',
                    }}
                  >
                    <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: '16px', fontFamily: FONT }}>
                      Select a model to explore
                    </p>
                  </div>
                ) : (
                  <ModelDetailPanel
                    model={selectedModel}
                    detail={currentDetail}
                    detailLoading={detailLoading}
                    onGenerate={handleGenerate}
                    onBack={() => {
                      setSelectedModel(null)
                      if (isMobile) setMobileShowList(true)
                    }}
                    backLabel="← Models"
                    showBackBtn={isMobile}
                  />
                )}
              </>
            )}

            {/* Mode 2 right panel */}
            {mode === 'guest' && (
              <>
                {/* State 1: No guest selected — empty state */}
                {!selectedGuest || !selectedGuestData ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      height: '100%',
                    }}
                  >
                    <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: '16px', fontFamily: FONT }}>
                      Select a guest to see their frameworks
                    </p>
                  </div>
                ) : selectedModel ? (
                  /* State 3: Guest selected + model selected — show model detail with back to guest */
                  <ModelDetailPanel
                    model={selectedModel}
                    detail={currentDetail}
                    detailLoading={detailLoading}
                    onGenerate={handleGenerate}
                    onBack={() => {
                      setSelectedModel(null)
                      if (isMobile) setMobileShowList(false)
                    }}
                    backLabel={`← ${selectedGuest}\u2019s frameworks`}
                    showBackBtn
                  />
                ) : (
                  /* State 2: Guest selected, no model — show guest detail */
                  <GuestDetailPanel
                    guestName={selectedGuest}
                    guestModels={selectedGuestData.models}
                    guestEpisodes={selectedGuestData.episodes}
                    onModelClick={handleGuestModelClick}
                    onBack={() => setMobileShowList(true)}
                    showBackBtn={isMobile}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
