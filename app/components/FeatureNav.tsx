'use client'

import Link from 'next/link'

const FEATURES = [
  { id: 'brain',   label: 'The Brain',   href: '/ask',           rgb: '232,84,58' },
  { id: 'library', label: 'The Library', href: '/mental-models', rgb: '56,189,248' },
  { id: 'arena',   label: 'The Arena',   href: '/debate',        rgb: '167,139,250' },
] as const

type FeatureId = (typeof FEATURES)[number]['id']

export default function FeatureNav({ currentFeature }: { currentFeature: FeatureId }) {
  const others = FEATURES.filter((f) => f.id !== currentFeature)

  return (
    <div style={{
      position: 'absolute',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      gap: '0.75rem',
    }}>
      {others.map((f) => (
        <Link
          key={f.id}
          href={f.href}
          style={{
            background: 'transparent',
            border: `1px solid rgba(${f.rgb}, 0.25)`,
            color: `rgb(${f.rgb})`,
            borderRadius: '100px',
            padding: '0.45rem 1.1rem',
            fontSize: '13px',
            fontWeight: 500,
            textDecoration: 'none',
            transition: 'all 0.2s',
            cursor: 'pointer',
            display: 'inline-block',
            lineHeight: 1.5,
          }}
          onMouseEnter={(e) => {
            const el = e.currentTarget as HTMLAnchorElement
            el.style.background = `rgba(${f.rgb}, 0.08)`
            el.style.borderColor = `rgba(${f.rgb}, 0.5)`
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget as HTMLAnchorElement
            el.style.background = 'transparent'
            el.style.borderColor = `rgba(${f.rgb}, 0.25)`
          }}
        >
          {f.label}
        </Link>
      ))}
    </div>
  )
}
