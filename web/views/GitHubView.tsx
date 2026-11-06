import { useState } from 'react'
import type { TicketRow, TrackerSnapshot } from '../../src/shared/types.js'
import { BOARD_CLASS, BOARD_ORDER, ago, builderOf, roleLabel } from '../lib.js'

export function GitHubView({ trackers, rows }: { trackers: TrackerSnapshot[]; rows: TicketRow[] }) {
  const t = trackers[0]
  const [filter, setFilter] = useState<string | null>(null)
  if (!t) {
    return (
      <section className="section">
        <header><h2>Tracker</h2></header>
        <p className="empty-note">No tracker yet. Start the hub inside a repo with a GitHub remote, or pass --repo PATH.</p>
      </section>
    )
  }
  const ms = t.milestone
  const total = Object.values(t.board).reduce((a, b) => a + b, 0)
  const done = t.board['Done'] ?? 0
  const pct = (n = 0) => (total ? (n / total) * 100 : 0)
  const statuses = [...BOARD_ORDER, ...Object.keys(t.board).filter((k) => !BOARD_ORDER.includes(k))]

  // Who holds each issue right now: the lane and agent from the live run.
  const holder = new Map<number, string>()
  for (const r of rows) {
    if (!r.finished) holder.set(r.ticket, [r.lane, roleLabel(builderOf(r)?.role)].filter(Boolean).join(' '))
  }

  const items = t.items
    .filter((i) => i.type !== 'Epic')
    .filter((i) => (filter ? i.status === filter : i.status !== 'Done'))
    .sort((a, b) => BOARD_ORDER.indexOf(b.status) - BOARD_ORDER.indexOf(a.status) || a.number - b.number)

  return (
    <section className="section">
      <header>
        <h2>{t.provider === 'github' ? 'GitHub' : t.provider} · {t.repo}</h2>
        <span className="hint">read-only · refreshed {ago(t.fetchedAt)} ago</span>
        <div className="right"><button onClick={() => void fetch('/api/refresh', { method: 'POST' })}>Refresh</button></div>
      </header>
      {t.error && <p className="err">Could not read the tracker: {t.error}</p>}
      <div className="grid2">
        <div>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            {ms ? (
              <>Milestone <a href={ms.url} target="_blank" rel="noreferrer"><b>{ms.title}</b></a>
                {ms.dueOn && <span className="muted"> · due {new Date(ms.dueOn).toLocaleDateString()}</span>}</>
            ) : <span className="muted">No open milestone</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
            <div className="bar" style={{ flex: 1 }} aria-label={`${done} of ${total} done`}>
              <span style={{ width: pct(done) + '%', background: 'var(--ok-fill)' }} />
              <span style={{ width: pct((t.board['In Progress'] ?? 0) + (t.board['In Review'] ?? 0)) + '%', background: 'var(--run-fill)' }} />
              <span style={{ width: pct(t.board['QA Validation']) + '%', background: 'var(--qa-fill)' }} />
              <span style={{ width: pct(t.board['Blocked']) + '%', background: 'var(--bad-fill)' }} />
            </div>
            <span>{done} of {total} done</span>
          </div>
          <div className="pills" style={{ margin: '10px 0 14px' }}>
            {statuses.filter((s) => t.board[s]).map((s) => (
              <span key={s} role="button" tabIndex={0} className={'pill ' + (BOARD_CLASS[s] ?? 's-waiting') + (filter === s ? ' on' : '')}
                onClick={() => setFilter(filter === s ? null : s)} onKeyDown={(e) => e.key === 'Enter' && setFilter(filter === s ? null : s)}>
                {s} {t.board[s]}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 4 }}>Epics</div>
          {t.epics.length ? t.epics.map((e) => (
            <div className="epic" key={e.number}>
              <span><a href={e.url} target="_blank" rel="noreferrer"><span className="n">#{e.number}</span> {e.title}</a></span>
              <div className="bar">
                <span style={{ width: (e.done / e.total) * 100 + '%', background: 'var(--ok-fill)' }} />
                <span style={{ width: (e.active / e.total) * 100 + '%', background: 'var(--run-fill)' }} />
                <span style={{ width: (e.blocked / e.total) * 100 + '%', background: 'var(--bad-fill)' }} />
              </div>
              <span style={{ fontSize: 12 }}>{e.done} of {e.total}</span>
            </div>
          )) : <p className="empty-note">No epics with sub-issues in this milestone.</p>}
        </div>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 4 }}>Issues · {filter ?? 'all not done'} ({items.length})</div>
          <div className="scroll">
            <table className="issues">
              <colgroup><col style={{ width: 50 }} /><col /><col style={{ width: 72 }} /><col style={{ width: 62 }} /><col style={{ width: 110 }} /><col style={{ width: 120 }} /><col style={{ width: 52 }} /></colgroup>
              <thead><tr><th>#</th><th>Title</th><th>Type</th><th>Epic</th><th>Status</th><th>Held by</th><th>PR</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.number}>
                    <td><a href={i.url} target="_blank" rel="noreferrer">#{i.number}</a></td>
                    <td title={i.title}>{i.title}</td>
                    <td className="muted">{i.type}</td>
                    <td className="muted">{i.epic ? '#' + i.epic : ''}</td>
                    <td><span className={'tag ' + (BOARD_CLASS[i.status] ?? 's-waiting')}>{i.status}</span></td>
                    <td className="muted">{holder.get(i.number) ?? (i.status === 'Blocked' ? 'needs you' : '')}</td>
                    <td>{i.prs[0] ? <a href={i.prs[0].url} target="_blank" rel="noreferrer">#{i.prs[0].number}</a> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!items.length && <p className="empty-note">Nothing in this column.</p>}
          </div>
        </div>
      </div>
    </section>
  )
}
