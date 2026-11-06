import type { Decision, TrackerSnapshot } from '../shared/types.js'
import type { LabelRules } from './config.js'

const lower = (xs: string[]) => xs.map((x) => x.toLowerCase())

// Items that wait on a person, read from the tracker. A harness adds its own with decision events.
//   - an open issue with a decision label (needs-human, needs-decision ... configurable)
//   - an open issue in the Blocked column or with a blocked label
//   - a green PR into an approval branch (configurable: main, stage, release ...), ready for a person to merge
export function trackerDecisions(snaps: TrackerSnapshot[], labels: LabelRules, approvalBranches: string[] = []): Decision[] {
  const out: Decision[] = []
  const want = lower(labels.decision)
  const blocked = lower(labels.blocked)
  for (const s of snaps) {
    const at = s.fetchedAt
    for (const i of s.items) {
      if (i.state !== 'open') continue
      const ls = lower(i.labels)
      const hit = ls.find((l) => want.includes(l))
      if (hit) {
        out.push({ id: `${s.repo}#${i.number}:decision`, title: `#${i.number} ${i.title}`, why: 'Labelled ' + hit, url: i.url, openedAt: at, source: s.provider, repo: s.repo, ticket: i.number, tracker: true })
      } else if (i.status === 'Blocked' || ls.some((l) => blocked.includes(l))) {
        out.push({ id: `${s.repo}#${i.number}:blocked`, title: `#${i.number} ${i.title}`, why: 'Blocked', url: i.url, openedAt: at, source: s.provider, repo: s.repo, ticket: i.number, tracker: true })
      }
    }
    for (const c of s.changes) {
      if (c.state !== 'open' || c.draft || !approvalBranches.includes(c.base)) continue
      const green = c.checks === 'success' || c.checks === 'none'
      out.push({
        id: `${s.repo}!${c.number}:approval`, title: `PR #${c.number} into ${c.base}`,
        why: green && c.mergeable !== 'conflicting' ? 'Checks green: ready for your merge' : 'Waiting on checks: ' + c.checks,
        url: c.url, openedAt: at, source: s.provider, repo: s.repo, tracker: true,
      })
    }
  }
  return out
}
