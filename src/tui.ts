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

export type View = 'all' | 'grid' | 'swim' | 'tree'

export function render(snap: Snapshot, width: number, s: Style = { color: true }, now = Date.now(), view: View = 'all'): string[] {
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

  if (view === 'all' || view === 'grid') out.push(...gridSection(snap, W, s, now))
  if (view === 'all' || view === 'swim') out.push(...swimlanes(snap, W, s, now))
  if (view === 'all' || view === 'tree') out.push(...worktreeGraph(snap, W, s))

  // Legend
  const key = (t: Tone, label: string) => paint(s, t, '  ') + ' ' + label
  const long = [key('done', 'Done'), key('run', 'Agent working now'), key('fail', 'Failed, back to recode'), key('need', 'Needs you'), key('none', 'Not reached or not needed')].join('   ')
  out.push(visible(long) <= W ? long : [key('done', 'done'), key('run', 'working'), key('fail', 'failed'), key('need', 'needs you'), key('none', 'not reached')].join('  '))
  return out
}

function gridSection(snap: Snapshot, W: number, s: Style, now: number): string[] {
  const out: string[] = []
  const decisions = snap.live.decisions
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

  return out
}

// ---------- swimlanes: one row per lane across time, each step a bar colored by the agent's role ----------

const ROLE_BG: Record<string, number> = {
  lead: 61, architect: 61, developer: 29, designer: 132, 'associate-developer': 136, tester: 25, 'qa-lead': 25,
  'design-auditor': 25, 'ui-aligner': 132, coordinator: 240, sre: 166, 'release-lead': 166,
}
const roleBg = (r?: string) => (r && ROLE_BG[r]) || 59
const WINDOWS = [1, 2, 5, 15, 60, 240]

export function swimlanes(snap: Snapshot, W: number, s: Style, now: number): string[] {
  const out: string[] = []
  const segs = snap.live.segments
  if (!segs.length) return out
  // The smallest window that holds every step from the last 4 hours, so short runs are not squeezed.
  const recent = segs.map((g) => Date.parse(g.start)).filter((t) => t >= now - 240 * 60_000)
  const earliest = recent.length ? Math.min(...recent) : now - 60_000
  const mins = WINDOWS.find((m) => now - earliest <= m * 60_000 * 0.95) ?? WINDOWS[WINDOWS.length - 1]!
  const t0 = now - mins * 60_000
  const visibleSegs = segs.filter((g) => (g.end ? Date.parse(g.end) : now) >= t0)
  if (!visibleSegs.length) return out
  const lanes = [...new Set(visibleSegs.map((g) => g.lane))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const LW = 16
  const T = Math.max(20, W - LW - 2)
  const x = (t: number) => Math.min(T - 1, Math.max(0, Math.floor(((t - t0) / (now - t0)) * (T - 1))))
  const clock = (t: number) => new Date(t).toLocaleTimeString([], mins <= 5 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' })

  out.push(bold(s, `Swimlanes · last ${mins >= 60 ? mins / 60 + ' h' : mins + ' min'}`) + dim(s, ' · each bar is one step, colored by agent'))
  // Time axis: four ticks and "now" at the right edge.
  const axis = Array<string>(T).fill(' ')
  for (let i = 0; i < 4; i++) {
    const t = t0 + ((now - t0) * i) / 4
    const label = clock(t)
    const at = x(t)
    for (let j = 0; j < label.length && at + j < T - 4; j++) axis[at + j] = label[j]!
  }
  'now'.split('').forEach((c, j) => (axis[T - 3 + j] = c))
  out.push(' '.repeat(LW + 1) + dim(s, axis.join('')))

  for (const lane of lanes) {
    const mine = visibleSegs.filter((g) => g.lane === lane)
    const lastRole = [...mine].reverse().find((g) => g.role && g.role !== 'coordinator' && g.role !== 'lead')?.role ?? mine.at(-1)?.role
    // Each column takes the colour and text of the step that covers it; later steps win.
    const cells: { bg?: number; ch: string; run?: boolean }[] = Array.from({ length: T }, () => ({ ch: '·' }))
    for (const g of mine) {
      const a = x(Math.max(Date.parse(g.start), t0))
      const b = Math.max(a, x(g.end ? Date.parse(g.end) : now))
      const bg = g.status === 'failed' ? 52 : g.status === 'skipped' ? undefined : roleBg(g.role)
      const text = ((STEP_LABELS[g.step] ?? g.step) + (g.ticket ? ' #' + g.ticket : '')).slice(0, b - a + 1)
      for (let c = a; c <= b; c++) cells[c] = { bg, ch: text[c - a] ?? ' ', run: !g.end }
      if (g.status === 'skipped') for (let c = a; c <= b; c++) cells[c] = { ch: '-' }
    }
    let row = ''
    for (const c of cells) {
      if (c.bg == null) row += dim(s, c.ch)
      else row += esc(s, `48;5;${c.bg};38;5;${c.run ? 231 : 253}`) + (c.run ? esc(s, '1') : '') + c.ch + reset(s)
    }
    out.push(bold(s, fit(lane, 5, 'left')) + dim(s, fit(role(lastRole), LW - 5, 'left')) + ' ' + row + fg(s, 203, '▏'))
  }
  const roles = [...new Set(visibleSegs.map((g) => g.role).filter((r): r is string => !!r))]
  const items = [...roles.map((r) => esc(s, `48;5;${roleBg(r)}`) + '  ' + reset(s) + ' ' + role(r)), esc(s, '48;5;52') + '  ' + reset(s) + ' failed', dim(s, 'bold: running')]
  // The legend wraps onto as many lines as the width needs.
  let line = ''
  for (const it of items) {
    if (line && visible(line) + 2 + visible(it) > W - LW - 1) { out.push(' '.repeat(LW + 1) + line); line = '' }
    line += (line ? '  ' : '') + it
  }
  if (line) out.push(' '.repeat(LW + 1) + line)
  out.push('')
  return out
}

// ---------- worktrees to merge: each lane's branch off the base, its commits, PR, checks and merge ----------

export function worktreeGraph(snap: Snapshot, W: number, s: Style): string[] {
  const out: string[] = []
  const tracker = snap.trackers[0]
  for (const g of snap.git) {
    if (g.error) { out.push(fg(s, 210, `${g.repoPath}: ${g.error}`), ''); continue }
    const base = g.base.replace(/^origin\//, '')
    const lanes = g.worktrees.filter((w) => w.branch !== base && !w.branch.endsWith('/' + base))
    if (!lanes.length) continue
    const rows = snap.live.rows
    out.push(bold(s, 'Worktrees to merge') + dim(s, ' · work reaches the base only through a PR'))
    out.push(fg(s, 141, '━'.repeat(Math.max(10, W - visible(g.base) - 12))) + ' ' + bold(s, fg(s, 141, g.base)) + dim(s, g.baseHead ? ' ' + g.baseHead : ''))
    const DOTS = 10
    const nameW = Math.min(30, Math.max(14, ...lanes.map((w) => w.branch.length)))
    lanes.forEach((w, i) => {
      const pr = tracker?.changes.find((c) => c.head === w.branch && c.state === 'open') ?? tracker?.changes.find((c) => c.head === w.branch)
      const conflict = pr?.mergeable === 'conflicting'
      const merged = pr?.state === 'merged'
      const col = conflict ? 210 : w.behind ? 222 : 114
      const stem = i === lanes.length - 1 ? ' ┗━' : ' ┣━'
      const n = Math.min(w.ahead, DOTS)
      const commits = Array.from({ length: n }, () => '●').join('━') + (w.ahead > DOTS ? '…' : '')
      const graph = fg(s, 141, stem) + fg(s, col, '━' + commits) + ' '.repeat(Math.max(1, DOTS * 2 + 2 - (commits.length + 1)))
      const lane = rows.find((r) => r.ticket === w.ticket)?.lane
      const counts = dim(s, `+${w.ahead} −${w.behind}${w.dirty ? ' ✎' : ''}${lane ? ' ' + lane : ''}`)
      const prPart = pr ? `PR #${pr.number}` : w.ahead ? 'not pushed or no PR' : 'no commits yet'
      const checks = !pr ? '' : conflict ? fg(s, 210, '✗ conflict') : pr.checks === 'success' ? fg(s, 114, '✓ checks green') : pr.checks === 'failure' ? fg(s, 210, '✗ checks red') : pr.checks === 'pending' ? fg(s, 117, '◌ checks running') : dim(s, 'no checks')
      const into = merged ? fg(s, 141, `merged into ${base}`)
        : conflict ? fg(s, 210, `lane merges ${base} in, fixes, re-runs checks`)
        : w.behind && pr ? fg(s, 222, `behind ${w.behind}: merges ${base} in first`)
        : pr && pr.checks === 'success' ? fg(s, 117, `merges into ${base} when checks pass`)
        : dim(s, 'waiting')
      const line = graph + fg(s, col, fit(w.branch, nameW, 'left')) + ' ' + counts + '  ▶ ' + prPart + '  ' + checks + '  → ' + into
      if (visible(line) <= W) out.push(line)
      else {
        // Too wide for one line: the way into the base goes on its own line, under the PR.
        const first = graph + fg(s, col, fit(w.branch, nameW, 'left')) + ' ' + counts + '  ▶ ' + prPart + '  ' + checks
        out.push(first)
        out.push(fg(s, 141, i === lanes.length - 1 ? '   ' : ' ┃ ') + ' '.repeat(Math.max(0, visible(graph) - 3 + nameW + 1)) + '→ ' + into)
      }
    })
    out.push(dim(s, '  Lanes never merge into each other locally: each pushes its branch, opens a PR, and the tracker merges it.'))
    out.push('')
  }
  return out
}

// ---------- rotation: the views take turns in the same space ----------

export const ROTATION: readonly View[] = ['grid', 'swim', 'tree']
export const VIEW_NAME: Record<View, string> = { all: 'everything', grid: 'grid', swim: 'swimlanes', tree: 'worktrees' }

// Which view shows at `now`, given when rotation started and its period. Views with nothing to show are
// skipped (no steps yet: no swimlanes; no worktrees: no graph), so the space never shows an empty view.
export function rotation(startMs: number, nowMs: number, periodSec: number, available: readonly View[] = ROTATION): { view: View; next: View; remainingSec: number } {
  const list = available.length ? available : ROTATION
  if (periodSec <= 0) return { view: list[0]!, next: list[0]!, remainingSec: 0 }
  const elapsed = Math.max(0, nowMs - startMs) / 1000
  const slot = Math.floor(elapsed / periodSec)
  const view = list[slot % list.length]!
  const next = list[(slot + 1) % list.length]!
  return { view, next, remainingSec: Math.ceil(periodSec - (elapsed % periodSec)) }
}

// The views worth rotating through for this snapshot.
export function availableViews(snap: Snapshot): View[] {
  const out: View[] = ['grid']
  if (snap.live.segments.length) out.push('swim')
  if (snap.git.some((g) => g.worktrees.some((w) => w.ticket != null))) out.push('tree')
  return out
}

export const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
