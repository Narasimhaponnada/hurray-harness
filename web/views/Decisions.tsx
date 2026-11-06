import { useState } from 'react'
import type { Decision } from '../../src/shared/types.js'
import { ago } from '../lib.js'

async function answer(id: string, choice: string): Promise<string | undefined> {
  try {
    const r = await fetch(`/api/decisions/${encodeURIComponent(id)}/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice, via: 'dashboard' }),
    })
    return r.ok ? undefined : ((await r.json()) as { error?: string }).error ?? 'Not recorded'
  } catch {
    return 'The hub is not reachable'
  }
}

export function Decisions({ items, answered = [] }: { items: Decision[]; answered?: Decision[] }) {
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  const [error, setError] = useState<Record<string, string>>({})
  const [sending, setSending] = useState<string>()
  const recent = answered.filter((d) => d.answer && Date.now() - Date.parse(d.answer.at) < 10 * 60_000).slice(0, 3)
  if (!items.length && !recent.length) return null
  if (!items.length) {
    return (
      <div className="decided" role="status" aria-live="polite">
        {recent.map((d) => (
          <span key={d.id}>Decided: <b>{d.title}</b> → {d.answer!.choice} <span className="muted">· via {d.answer!.via}, {ago(d.answer!.at)} ago</span></span>
        ))}
      </div>
    )
  }
  return (
    <div className="decisions" role="status" aria-live="polite">
      <h2>
        Needs your decision ({items.length})
        {perm === 'default' && (
          <button style={{ marginLeft: 12, fontSize: 12, padding: '1px 8px' }} onClick={() => void Notification.requestPermission().then(setPerm)}>
            Notify me on this computer
          </button>
        )}
      </h2>
      <ul>
        {items.map((d) => (
          <li key={d.id}>
            <b>{d.url ? <a href={d.url} target="_blank" rel="noreferrer">{d.title}</a> : d.title}</b>
            {d.why && <span>{d.why}</span>}
            {d.recommendation && <span className="muted">· {d.recommendation}</span>}
            <span className="muted">· {ago(d.openedAt)} ago</span>
            {!!d.options?.length && (
              <span className="options">
                {d.options.map((o) => (
                  <button
                    key={o}
                    disabled={sending === d.id}
                    className={d.recommendation?.toLowerCase() === o.toLowerCase() ? 'recommended' : undefined}
                    onClick={() => {
                      setSending(d.id)
                      void answer(d.id, o).then((err) => { setSending(undefined); setError((e) => ({ ...e, [d.id]: err ?? '' })) })
                    }}
                  >
                    {o}
                  </button>
                ))}
                {error[d.id] && <span className="err">{error[d.id]}</span>}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
