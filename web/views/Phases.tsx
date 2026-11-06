import type { Decision, PhaseState } from '../../src/shared/types.js'
import { statusClass } from '../lib.js'

const PHASE_WORDS: Record<string, string> = { done: 'done', running: 'now', waiting: 'not yet', failed: 'failed', blocked: 'waits on you', skipped: 'skipped' }
const isApproval = (d: Decision) => d.id.endsWith(':approval')

// Where a person decides: an approval PR holds up the next of Promote or Release that is not done;
// any other open decision holds up whichever phase is running now.
function gatedPhases(phases: PhaseState[], decisions: Decision[]): Set<string> {
  const out = new Set<string>()
  if (decisions.some(isApproval)) {
    const next = phases.find((p) => (p.name === 'Promote' || p.name === 'Release') && p.status !== 'done')
    if (next) out.add(next.name)
  }
  if (decisions.some((d) => !isApproval(d))) for (const p of phases) if (p.status === 'running') out.add(p.name)
  return out
}

export function Phases({ phases, decisions }: { phases: PhaseState[]; decisions: Decision[] }) {
  const gated = gatedPhases(phases, decisions)
  return (
    <div className="phases">
      {phases.map((p) => {
        const gate = gated.has(p.name)
        return (
          <div key={p.name} className={'phase ' + (gate ? 's-blocked' : statusClass(p.status))} title={p.detail ?? ''}>
            <b>{p.name}</b>
            <span className="mono">{p.skill ?? ''}</span>
            <br />
            <span>{gate ? 'waits on you' : PHASE_WORDS[p.status] ?? p.status}</span>
          </div>
        )
      })}
    </div>
  )
}
