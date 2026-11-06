import { useState } from 'react'
import { DEV_STEPS, QA_STEPS, STEP_LABELS } from '../../src/shared/reduce.js'
import type { StepState, TicketRow } from '../../src/shared/types.js'
import { ago, builderOf, roleLabel, short, statusClass } from '../lib.js'

const WORD: Record<string, string> = { done: 'done', running: 'working', failed: 'failed', blocked: 'blocked', waiting: '', skipped: 'not needed' }

function cellText(step: string, s: StepState, row: TicketRow): string {
  if (s.status === 'running' && s.attempt > 1) return 'recode ' + s.attempt
  if (s.status === 'done' && step === 'pr' && row.pr) return '#' + row.pr
  if (s.status === 'done' && step === 'tests') return s.files.some((f) => /adr/i.test(f)) ? 'ADR' : s.files.some((f) => /(^|\/)docs?\//.test(f) || f.endsWith('.md')) ? 'docs' : 'tests'
  return WORD[s.status] ?? s.status
}

export function LaneGrid({ rows }: { rows: TicketRow[] }) {
  const [sel, setSel] = useState<{ key: string; step: string } | null>(null)
  if (!rows.length) {
    return <p className="empty-note">No agent steps yet. Lanes appear as soon as a harness sends step events (docs/EVENTS.md), or as tool hooks tie activity to a worktree.</p>
  }
  const groups: { title: string; steps: readonly string[]; rows: TicketRow[] }[] = [
    { title: 'Build lanes', steps: DEV_STEPS, rows: rows.filter((r) => r.kind !== 'qa') },
    { title: 'Test lanes', steps: QA_STEPS, rows: rows.filter((r) => r.kind === 'qa') },
  ].filter((g) => g.rows.length)

  // Show the running cell first when nothing is selected.
  let selected = sel ? rows.find((r) => r.key === sel.key) : undefined
  let selStep = sel?.step
  if (!selected) {
    selected = rows.find((r) => r.current && r.steps[r.current]?.status === 'running')
    selStep = selected?.current
  }
  const s = selected && selStep ? selected.steps[selStep] : undefined

  return (
    <div>
      {groups.map((g) => (
        <div key={g.title} style={{ marginBottom: 12 }}>
          {groups.length > 1 && <div style={{ fontSize: 12, color: 'var(--text-2)', margin: '2px 0 6px' }}>{g.title}</div>}
          <div className="lanes" style={{ gridTemplateColumns: `130px repeat(${g.steps.length}, minmax(0, 1fr))` }}>
            <div />
            {g.steps.map((st) => <div className="h" key={st}>{STEP_LABELS[st] ?? st}</div>)}
            {g.rows.map((r) => (
              <Row key={r.key} row={r} steps={g.steps} selected={selected?.key === r.key ? selStep : undefined} onPick={(step) => setSel({ key: r.key, step })} />
            ))}
          </div>
        </div>
      ))}
      {selected && selStep && s ? <Detail row={selected} step={selStep} s={s} /> : null}
      <div className="legend">
        <span><i className="s-done" />Done</span><span><i className="s-running" />Agent working now</span>
        <span><i className="s-failed" />Failed, goes back to recode</span><span><i className="s-blocked" />Needs you</span>
        <span><i className="s-waiting" />Not reached</span>
      </div>
    </div>
  )
}

function Row({ row, steps, selected, onPick }: { row: TicketRow; steps: readonly string[]; selected?: string; onPick: (s: string) => void }) {
  const builder = builderOf(row)
  return (
    <>
      <div className="who">
        <b>{row.lane ? row.lane + ' · ' : ''}#{row.ticket}</b>
        <span title={row.title}>{row.title ?? ''}</span>
        <span>{[row.epic ? 'epic ' + row.epic : '', builder ? roleLabel(builder.role) + (builder.model ? ' ' + builder.model : '') : ''].filter(Boolean).join(' · ')}</span>
      </div>
      {steps.map((st) => {
        const s = row.steps[st]
        if (!s) return <div key={st} className="cell s-waiting empty" />
        return (
          <div key={st} role="button" tabIndex={0}
            className={'cell ' + statusClass(s.status) + (s.status === 'running' ? ' running-pulse' : '') + (selected === st ? ' sel' : '')}
            onClick={() => onPick(st)} onKeyDown={(e) => e.key === 'Enter' && onPick(st)}
            title={[s.skill, s.agent?.role, s.detail].filter(Boolean).join(' · ')}>
            <span>{cellText(st, s, row)}</span>
            {s.agent && <span className="a">{roleLabel(s.agent.role)}</span>}
          </div>
        )
      })}
    </>
  )
}

function Detail({ row, step, s }: { row: TicketRow; step: string; s: StepState }) {
  const pct = s.tokens?.used && s.tokens.budget ? Math.round((s.tokens.used / s.tokens.budget) * 100) : undefined
  const elapsed = s.startedAt ? ago(s.startedAt, s.endedAt ? Date.parse(s.endedAt) : Date.now()) : ''
  return (
    <div className="detail">
      <h3>#{row.ticket} {row.title ?? ''} · {STEP_LABELS[step] ?? step}</h3>
      <dl className="kv">
        <dt>Status</dt><dd>{s.status}{s.attempt > 1 ? ` · attempt ${s.attempt} (recode loop)` : ''}</dd>
        {s.skill && <><dt>Skill</dt><dd><code>{s.skill}</code></dd></>}
        {s.agent && <><dt>Agent</dt><dd>{s.agent.role}{s.agent.model ? ' · ' + s.agent.model : ''}{s.agent.name ? ' · ' + s.agent.name : ''}</dd></>}
        {s.detail && <><dt>{s.status === 'running' ? 'Doing now' : 'Last action'}</dt><dd>{s.detail}</dd></>}
        {s.files.length > 0 && <><dt>Files</dt><dd><code>{s.files.join(', ')}</code></dd></>}
        {elapsed && <><dt>Time on step</dt><dd>{elapsed}</dd></>}
        {s.tokens?.budget ? (
          <><dt>Budget</dt><dd>
            {short(s.tokens.used ?? 0)} of {short(s.tokens.budget)} ({pct}%)
            <div className="bar" style={{ marginTop: 4, maxWidth: 320 }}>
              <span style={{ width: Math.min(pct ?? 0, 100) + '%', background: (pct ?? 0) >= 80 ? 'var(--warn-fill)' : 'var(--run-fill)' }} />
            </div>
          </dd></>
        ) : null}
        {(row.branch || row.pr) && <><dt>Branch</dt><dd><code>{row.branch ?? ''}</code>{row.pr ? ' · PR #' + row.pr : ''}</dd></>}
      </dl>
    </div>
  )
}
