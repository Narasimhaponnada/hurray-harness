import { DEV_STEPS, QA_STEPS, STEP_LABELS } from './shared/reduce.js'
import type { Decision, PhaseState, Snapshot, StepState, TicketRow } from './shared/types.js'

// The terminal view (hh watch): the same phases strip and ticket grid as the dashboard, drawn with ANSI
// colors. render() is pure: snapshot and width in, lines out.

type Tone = 'done' | 'run' | 'fail' | 'need' | 'none' | 'qa'

// 256-color backgrounds and foregrounds chosen to read on dark and light terminals.
const TONE: Record<Tone, { bg: number; fg: number }> = {
  done: { bg: 22, fg: 150 },
  run: { bg: 24, fg: 153 },
  fail: { bg: 52, fg: 217 },
  need: { bg: 94, fg: 223 },
  none: { bg: 236, fg: 245 },
  qa: { bg: 54, fg: 183 },
}

export interface Style { color: boolean }

const esc = (s: Style, code: string) => (s.color ? `\x1b[${code}m` : '')
const reset = (s: Style) => esc(s, '0')
const bold = (s: Style, t: string) => esc(s, '1') + t + reset(s)
const dim = (s: Style, t: string) => esc(s, '2') + t + reset(s)
const fg = (s: Style, n: number, t: string) => esc(s, '38;5;' + n) + t + reset(s)
const paint = (s: Style, tone: Tone, t: string) => esc(s, `48;5;${TONE[tone].bg};38;5;${TONE[tone].fg}`) + t + reset(s)

// Visible width, ignoring escape codes; wide glyphs are rare here and counted as one.
export const visible = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '').length

function fit(t: string, w: number, align: 'left' | 'center' = 'center'): string {
  if (w <= 0) return ''
  const s = t.length > w ? t.slice(0, Math.max(0, w - 1)) + '…' : t
  if (align === 'left') return s + ' '.repeat(w - s.length)
  const left = Math.floor((w - s.length) / 2)
  return ' '.repeat(left) + s + ' '.repeat(w - s.length - left)
}

const toneOf = (status?: string): Tone =>
  status === 'done' ? 'done' : status === 'running' ? 'run' : status === 'failed' ? 'fail' : status === 'blocked' ? 'need' : 'none'

const ROLE: Record<string, string> = { 'associate-developer': 'assoc dev', 'ui-aligner': 'ui aligner', 'design-auditor': 'design aud', 'qa-lead': 'QA lead', 'release-lead': 'rel lead' }
const role = (r?: string) => (r ? ROLE[r] ?? r : '')
// In a narrow terminal, agent names shrink rather than lose their ends.
const SHORT: Record<string, string> = { developer: 'dev', coordinator: 'coord', architect: 'arch', 'ui aligner': 'ui align', 'assoc dev': 'assoc', 'design aud': 'design', designer: 'design' }

const WORD: Record<string, string> = { done: 'done', running: 'working', failed: 'failed', blocked: 'blocked', waiting: '', skipped: 'none' }

function cellWords(step: string, s: StepState | undefined, row: TicketRow): [string, string] {
  if (!s) return ['–', '']
  let top = WORD[s.status] ?? s.status
  if (s.status === 'running' && s.attempt > 1) top = `recode ${s.attempt}`
  else if (s.status === 'done' && step === 'pr' && row.pr) top = `#${row.pr}`
  else if (s.status === 'done' && step === 'tests') top = s.files.some((f) => /adr/i.test(f)) ? 'ADR' : s.files.some((f) => /(^|\/)docs?\//.test(f) || f.endsWith('.md')) ? 'docs' : 'tests'
  return [top, s.status === 'skipped' ? '' : role(s.agent?.role)]
}

const PHASE_WORD: Record<string, string> = { done: 'done', running: 'now', waiting: 'waiting', failed: 'failed', blocked: 'waits on you', skipped: 'skipped' }

function gated(phases: PhaseState[], decisions: Decision[]): Set<string> {
  const out = new Set<string>()
  const approval = (d: Decision) => d.id.endsWith(':approval')
  if (decisions.some(approval)) {
    const next = phases.find((p) => (p.name === 'Promote' || p.name === 'Release') && p.status !== 'done')
    if (next) out.add(next.name)
  }
  if (decisions.some((d) => !approval(d))) for (const p of phases) if (p.status === 'running') out.add(p.name)
  return out
}

export function render(snap: Snapshot, width: number, s: Style = { color: true }, now = Date.now()): string[] {
  const W = Math.max(60, width)
  const out: string[] = []
  const tracker = snap.trackers[0]
  const run = snap.live.runs.find((r) => r.status === 'running') ?? snap.live.runs[0]
  const decisions = snap.live.decisions

  // Header
  const board = tracker?.board ?? {}
  const total = Object.values(board).reduce((a, b) => a + b, 0)
  const done = board['Done'] ?? 0
  const head = [tracker?.repo ?? run?.repo, (tracker?.milestone?.title ?? run?.milestone) ? 'milestone ' + (tracker?.milestone?.title ?? run?.milestone) : '', run?.status === 'running' ? run.stage : ''].filter(Boolean).join(' · ')
  const barW = 20
  const fill = total ? Math.round((done / total) * barW) : 0
  const progress = total ? '   ' + fg(s, 114, '█'.repeat(fill)) + dim(s, '░'.repeat(barW - fill)) + ` ${done}/${total} done` : ''
  const title = 'hurray-harness  ' + head
  // On a narrow terminal the progress bar takes its own line.
  if (visible(title + progress) <= W) out.push(bold(s, 'hurray-harness') + '  ' + head + progress)
  else { out.push(bold(s, 'hurray-harness') + '  ' + fit(head, W - 16, 'left').trimEnd()); if (progress) out.push(progress.trimStart()) }
  out.push('')

  // Decisions
  if (decisions.length) {
    out.push(paint(s, 'need', fit(` Needs your decision (${decisions.length})`, W, 'left')))
    for (const d of decisions.slice(0, 4)) out.push(paint(s, 'need', fit(`   ${d.title}${d.why ? ' · ' + d.why : ''}`, W, 'left')))
    out.push('')
  }

  // Phases strip: two lines per box, the gate under it.
  const phases = snap.live.phases
  const gates = gated(phases, decisions)
  const pw = Math.max(5, Math.floor((W - (phases.length - 1)) / phases.length))
  const toneP = (p: PhaseState): Tone => (gates.has(p.name) ? 'need' : toneOf(p.status))
  out.push(bold(s, 'Product phases'))
  out.push(phases.map((p) => paint(s, toneP(p), fit(p.name, pw))).join(' '))
  out.push(phases.map((p) => paint(s, toneP(p), fit(gates.has(p.name) ? 'waits on you' : PHASE_WORD[p.status] ?? p.status, pw))).join(' '))
  out.push(phases.map((p) => paint(s, toneP(p), fit(p.skill ?? '', pw))).join(' '))
  out.push('')

  // Ticket grids
  const rows = snap.live.rows.filter((r) => !r.finished || r.updatedAt >= new Date(now - 30 * 60_000).toISOString())
  const groups: { title: string; steps: readonly string[]; rows: TicketRow[] }[] = [
    { title: 'Tickets in flight · each cell shows status and the agent on it', steps: DEV_STEPS, rows: rows.filter((r) => r.kind !== 'qa') },
    { title: 'Test lanes', steps: QA_STEPS, rows: rows.filter((r) => r.kind === 'qa') },
  ]
  const labelW = Math.min(22, Math.max(14, Math.floor(W * 0.16)))
  for (const g of groups) {
    if (!g.rows.length) continue
    const cw = Math.max(5, Math.floor((W - labelW - g.steps.length) / g.steps.length))
    out.push(bold(s, g.title))
    const short: Record<string, string> = { tests: 'Tests, docs', close: 'Close, QA', 'second-look': '2nd look', 'cycle-close': 'Close cycle', 'cycle-open': 'Open cycle' }
    out.push(' '.repeat(labelW) + g.steps.map((st) => ' ' + dim(s, fit(cw < 14 ? short[st] ?? STEP_LABELS[st] ?? st : STEP_LABELS[st] ?? st, cw))).join(''))
    for (const r of g.rows) {
      const name = `#${r.ticket} ${r.title ?? ''}`
      const sub = [r.epic ? 'epic ' + r.epic : '', r.lane].filter(Boolean).join(' · ')
      const cells = g.steps.map((st) => {
        const step = r.steps[st]
        const [top, bottom] = cellWords(st, step, r)
        const tone: Tone = step ? (step.status === 'skipped' ? 'none' : toneOf(step.status)) : 'none'
        return { tone, top, bottom: bottom.length > cw ? SHORT[bottom] ?? bottom : bottom }
      })
      out.push(bold(s, fit(name, labelW, 'left')) + cells.map((c) => ' ' + paint(s, c.tone, fit(c.top, cw))).join(''))
      out.push(dim(s, fit(sub, labelW, 'left')) + cells.map((c) => ' ' + paint(s, c.tone, fit(c.bottom, cw))).join(''))
      // What the agent is doing now, under the row, when something runs.
      const cur = r.current ? r.steps[r.current] : undefined
      if (cur?.status === 'running' && cur.detail) {
        out.push(' '.repeat(labelW) + ' ' + dim(s, fit(`↳ ${[cur.skill, cur.agent?.model].filter(Boolean).join(' · ')}${cur.skill || cur.agent?.model ? ' · ' : ''}${cur.detail}`, W - labelW - 1, 'left')))
      } else {
        out.push('')
      }
    }
    out.push('')
  }
  if (!rows.length) out.push(dim(s, 'No agent steps yet. Lanes appear when a harness sends steps (hh step) or a tool hook ties activity to a worktree.'), '')

  // Worktrees, one line each
  const wts = snap.git.flatMap((g) => g.worktrees.filter((w) => w.ticket != null))
  if (wts.length) {
    out.push(bold(s, 'Worktrees to merge'))
    for (const w of wts) {
      const pr = tracker?.changes.find((c) => c.head === w.branch && c.state === 'open') ?? tracker?.changes.find((c) => c.head === w.branch)
      const conflict = pr?.mergeable === 'conflicting'
      const line = `  ${w.branch}  +${w.ahead} −${w.behind}${w.dirty ? ' · uncommitted' : ''}${pr ? ` · PR #${pr.number} ${conflict ? 'conflict' : 'checks ' + pr.checks}` : ' · no PR'}`
      out.push(conflict ? fg(s, 210, line) : w.behind ? fg(s, 222, line) : line)
    }
    out.push('')
  }

  // Legend
  const key = (t: Tone, label: string) => paint(s, t, '  ') + ' ' + label
  const long = [key('done', 'Done'), key('run', 'Agent working now'), key('fail', 'Failed, back to recode'), key('need', 'Needs you'), key('none', 'Not reached or not needed')].join('   ')
  out.push(visible(long) <= W ? long : [key('done', 'done'), key('run', 'working'), key('fail', 'failed'), key('need', 'needs you'), key('none', 'not reached')].join('  '))
  return out
}
