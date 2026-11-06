import { useState } from 'react'
import type { Decision } from '../../src/shared/types.js'
import { ago } from '../lib.js'

export function Decisions({ items }: { items: Decision[] }) {
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  if (!items.length) return null
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
          </li>
        ))}
      </ul>
    </div>
  )
}
