import { STEP_LABELS } from '../../src/shared/reduce.js'
import type { AgentState } from '../../src/shared/types.js'
import { ago, roleColor, roleLabel } from '../lib.js'

const laneOf = (a: AgentState) => {
  const lane = a.key.split(':').at(-2)
  return lane && lane !== '-' ? lane : roleLabel(a.role)
}

// Busy agents get a card each; idle ones collapse into one line per role so the panel stays short.
export function Agents({ agents }: { agents: AgentState[] }) {
  if (!agents.length) return <p className="empty-note">No agents reported yet.</p>
  const byRole = new Map<string, AgentState[]>()
  for (const a of agents) byRole.set(a.role, [...(byRole.get(a.role) ?? []), a])
  const roles = [...byRole.entries()].sort((x, y) => y[1].filter((a) => a.status === 'busy').length - x[1].filter((a) => a.status === 'busy').length)
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {roles.map(([role, list]) => {
        const busy = list.filter((a) => a.status === 'busy')
        const idle = list.filter((a) => a.status !== 'busy')
        return (
          <div key={role}>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 4 }}>
              <i className="dot" style={{ background: roleColor(role) }} />
              <b style={{ color: 'var(--text)', fontWeight: 600 }}>{roleLabel(role)}</b> · {busy.length} busy
              {idle.length > 0 && <span className="muted"> · idle: {idle.map(laneOf).join(', ')}</span>}
            </div>
            {busy.length > 0 && (
              <div className="agents">
                {busy.map((a) => (
                  <div key={a.key} className="agent" style={{ borderColor: roleColor(role) }}>
                    <b>{laneOf(a)}</b>{a.model && <span style={{ display: 'inline' }}> · {a.model}</span>}
                    <span>{STEP_LABELS[a.step ?? ''] ?? a.step ?? ''}{a.ticket ? ' #' + a.ticket : ''} · {ago(a.since)}</span>
                    {a.skill && <span className="mono">{a.skill}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
