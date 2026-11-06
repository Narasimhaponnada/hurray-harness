import type { AgentRef, Status, TicketRow } from '../src/shared/types.js'

export const statusClass = (s?: Status | string) => 's-' + (s ?? 'none')

// One color per kind of agent, used in the swimlanes. Gray for GitHub plumbing.
export const ROLE_COLORS: Record<string, string> = {
  lead: '#7F77DD',
  architect: '#7F77DD',
  developer: '#1D9E75',
  designer: '#D4537E',
  'associate-developer': '#BA7517',
  tester: '#378ADD',
  'qa-lead': '#378ADD',
  'design-auditor': '#378ADD',
  'ui-aligner': '#D4537E',
  coordinator: '#888780',
  sre: '#D85A30',
  'release-lead': '#D85A30',
}
export const roleColor = (role?: string) => (role && ROLE_COLORS[role]) || '#5F5E5A'

export const ROLE_LABEL: Record<string, string> = { 'associate-developer': 'assoc dev', 'ui-aligner': 'ui aligner', 'design-auditor': 'design auditor', 'qa-lead': 'QA lead', 'release-lead': 'release lead' }
export const roleLabel = (role?: string) => (role ? ROLE_LABEL[role] ?? role : '')

export function ago(iso?: string, now = Date.now()): string {
  if (!iso) return ''
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return s + ' s'
  const m = Math.round(s / 60)
  if (m < 60) return m + ' min'
  const h = Math.floor(m / 60)
  return h + ' h ' + (m % 60) + ' min'
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export const BOARD_ORDER = ['Backlog', 'Ready', 'In Progress', 'In Review', 'QA Validation', 'Done', 'Blocked']
export const BOARD_CLASS: Record<string, string> = {
  Backlog: 's-waiting', Ready: 's-waiting', 'In Progress': 's-running', 'In Review': 's-running', 'QA Validation': 's-qa', Done: 's-done', Blocked: 's-failed',
}

// The agent that builds a ticket (not the coordinator that merges it), for row labels.
export function builderOf(row: TicketRow): AgentRef | undefined {
  for (const st of ['code', 'tests', 'run', 'verify', 'qa-plan']) {
    const a = row.steps[st]?.agent
    if (a && a.role !== 'coordinator') return a
  }
  return (row.current ? row.steps[row.current]?.agent : undefined) ?? Object.values(row.steps).at(-1)?.agent
}

export function short(n: number) {
  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}
