import type { ActivityItem } from '../../src/shared/types.js'
import { clock } from '../lib.js'

export function Activity({ items }: { items: ActivityItem[] }) {
  if (!items.length) return <p className="empty-note">No hook activity yet. See docs/INTEGRATIONS.md to connect Claude Code or Cursor.</p>
  return (
    <ul className="activity">
      {items.map((a, i) => (
        <li key={i}>
          <span className="muted">{clock(a.ts)}</span>
          <span className="muted">{a.source}</span>
          <span>{a.ticket ? '#' + a.ticket : ''}</span>
          <span title={a.detail}>{a.detail}</span>
        </li>
      ))}
    </ul>
  )
}
