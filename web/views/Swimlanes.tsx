import { useEffect, useRef, useState } from 'react'
import { STEP_LABELS } from '../../src/shared/reduce.js'
import type { Segment } from '../../src/shared/types.js'
import { ROLE_COLORS, roleColor, roleLabel } from '../lib.js'

const WINDOWS = [{ label: '15 min', ms: 15 * 60_000 }, { label: '1 h', ms: 3_600_000 }, { label: '4 h', ms: 4 * 3_600_000 }, { label: 'All', ms: 0 }]

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(900)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(360, e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return { ref, w }
}

// Shortens a bar label to what fits, at about 6.3 px per character of 11 px text.
function fit(label: string, px: number): string {
  const n = Math.floor(px / 6.3)
  if (label.length <= n) return label
  const hash = label.lastIndexOf(' #')
  const tail = hash > 0 ? label.slice(hash + 1) : ''
  if (tail && tail.length <= n) return tail
  return n > 2 ? label.slice(0, n - 1) + '…' : ''
}

export function Swimlanes({ segments }: { segments: Segment[] }) {
  const { ref, w } = useWidth()
  const [win, setWin] = useState(0)
  const now = Date.now()
  if (!segments.length) return <div ref={ref}><p className="empty-note">No steps recorded yet.</p></div>

  const firstStart = Math.min(...segments.map((s) => Date.parse(s.start)))
  const span = WINDOWS[win]!.ms
  const t0 = span ? Math.max(firstStart, now - span) : firstStart
  const t1 = Math.max(now, t0 + 60_000)
  const visible = segments.filter((s) => (s.end ? Date.parse(s.end) : now) >= t0)
  const lanes = [...new Set(visible.map((s) => s.lane))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const LEFT = 90, TOP = 22, ROW = 34, BAR = 22
  const x = (t: number) => LEFT + ((t - t0) / (t1 - t0)) * (w - LEFT - 12)
  const h = TOP + lanes.length * ROW + 10
  const ticks = 5
  const roles = [...new Set(visible.map((s) => s.role).filter((r): r is string => !!r))]

  return (
    <div ref={ref}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {WINDOWS.map((o, i) => <button key={o.label} aria-pressed={i === win} onClick={() => setWin(i)}>{o.label}</button>)}
      </div>
      <svg width={w} height={h} role="img" aria-label="Swimlane timeline of agent steps per lane">
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const t = t0 + ((t1 - t0) * i) / ticks
          return (
            <g key={i}>
              <line x1={x(t)} x2={x(t)} y1={TOP - 4} y2={h - 6} stroke="var(--line)" />
              <text x={x(t)} y={12} className="t3" textAnchor={i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}>
                {new Date(t).toLocaleTimeString([], t1 - t0 < 10 * 60_000 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' })}
              </text>
            </g>
          )
        })}
        {lanes.map((lane, li) => {
          const y = TOP + li * ROW
          const segs = visible.filter((s) => s.lane === lane)
          return (
            <g key={lane}>
              <text x={4} y={y + 15} style={{ fontSize: 12, fontWeight: 600 }}>{lane}</text>
              <text x={4} y={y + 28} className="t3">{roleLabel([...segs].reverse().find((s) => s.role && s.role !== 'coordinator' && s.role !== 'lead')?.role ?? segs.at(-1)?.role)}</text>
              {segs.map((s, i) => {
                const a = Math.max(x(Date.parse(s.start)), LEFT)
                const b = x(s.end ? Date.parse(s.end) : now)
                const width = Math.max(3, b - a)
                const failed = s.status === 'failed'
                const fill = failed ? 'var(--bad-fill)' : s.status === 'skipped' ? 'var(--sunk)' : roleColor(s.role)
                const label = (STEP_LABELS[s.step] ?? s.step) + (s.ticket ? ' #' + s.ticket : '')
                return (
                  <g key={i}>
                    <title>{`${label} · ${s.role ?? ''} · ${s.skill ?? ''} · ${s.status}`}</title>
                    <rect x={a} y={y + 4} width={width} height={BAR} rx={4} fill={fill} opacity={s.end ? 0.85 : 1}
                      stroke={s.end ? 'none' : 'var(--text)'} strokeWidth={s.end ? 0 : 1} />
                    {width > 30 && <text x={a + 6} y={y + 19} style={{ fontSize: 11, fill: '#fff' }}>{fit(label, width - 10)}</text>}
                  </g>
                )
              })}
            </g>
          )
        })}
        <line x1={x(now)} x2={x(now)} y1={TOP - 6} y2={h - 4} stroke="var(--bad-fill)" strokeWidth={1.5} />
      </svg>
      <div className="legend">
        {roles.map((r) => <span key={r}><i style={{ background: ROLE_COLORS[r] ?? roleColor(r) }} />{roleLabel(r)}</span>)}
        <span><i style={{ background: 'var(--bad-fill)' }} />failed</span>
        <span>outlined bar: still running · red line: now</span>
      </div>
    </div>
  )
}
