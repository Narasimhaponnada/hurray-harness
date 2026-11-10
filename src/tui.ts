import { DEV_STEPS, QA_STEPS, STEP_LABELS } from './shared/reduce.js'
import type { Decision, PhaseState, Snapshot, StepState, TicketRow } from './shared/types.js'
import { STAGE_WORD, doneOf, workInFlight, type Stage, type WorkRow } from './shared/work.js'

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

export type View = 'all' | 'now' | 'flow'

export function render(snap: Snapshot, width: number, s: Style = { color: true }, now = Date.now(), view: View = 'all'): string[] {
  const W = Math.max(60, width)
  const out: string[] = []
  const tracker = snap.trackers[0]
  const run = snap.live.runs.find((r) => r.status === 'running') ?? snap.live.runs[0]
  const decisions = snap.live.decisions

  // Header
  const board = tracker?.board ?? {}
  const total = Object.values(board).reduce((a, b) => a + b, 0)
  const done = doneOf(board)
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
    for (const d of decisions.slice(0, 4)) {
      out.push(paint(s, 'need', fit(`   ${d.title}${d.why ? ' · ' + d.why : ''}`, W, 'left')))
      if (d.options?.length) out.push(paint(s, 'need', fit(`     ${d.options.join(' / ')} · hh answer ${d.id} "<option>"`, W, 'left')))
    }
    out.push('')
  }

  // Two views: Now (what is happening and who is doing it) and Flow (how work moves and where it stands on merging).
  if (view === 'all' || view === 'now') out.push(...nowView(snap, W, s, now))
  if (view === 'all' || view === 'flow') out.push(...flowView(snap, W, s, now))

  // Legend
  const key = (t: Tone, label: string) => paint(s, t, '  ') + ' ' + label
  const long = [key('done', 'Done'), key('run', 'Agent working now'), key('fail', 'Failed, back to recode'), key('need', 'Needs you'), key('none', 'Not reached or not needed')].join('   ')
  out.push(visible(long) <= W ? long : [key('done', 'done'), key('run', 'working'), key('fail', 'failed'), key('need', 'needs you'), key('none', 'not reached')].join('  '))
  return out
}

const STAGE_FG: Record<Stage, number> = { blocked: 214, working: 75, review: 183, qa: 179, todo: 245, done: 71 }

// What the tracker has in flight: bugs and issues in progress, in review, in QA or blocked, each with
// its PR and who has it. Agent lanes show what agents do; this shows what the team's board says.
function githubNow(snap: Snapshot, W: number, s: Style): string[] {
  const out: string[] = []
  for (const t of snap.trackers) {
    if (t.error && !t.items.length) { out.push(bold(s, 'Now on GitHub ') + dim(s, '· could not read: ' + t.error), ''); continue }
    const w = workInFlight(t)
    // Tickets already in the grid above are not listed again; the counts still cover them all.
    const inGrid = new Set(snap.live.rows.filter((r) => !r.repo || r.repo === t.repo).map((r) => r.ticket))
    const listed = w.rows.filter((r) => !inGrid.has(r.number))
    const parts = [
      w.counts.working && `${w.counts.working} in progress`, w.counts.review && `${w.counts.review} in review`,
      w.counts.qa && `${w.counts.qa} in QA`, w.counts.blocked && `${w.counts.blocked} blocked`,
      `${w.bugsOpen} open bug${w.bugsOpen === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · ')
    out.push(bold(s, 'Now on GitHub') + dim(s, fit(` · ${snap.trackers.length > 1 ? t.repo + ' · ' : ''}${parts}`, Math.max(0, W - 13), 'left').trimEnd()))
    if (!w.rows.length) out.push(dim(s, '  Nothing in progress, in review, in QA or blocked.'))
    const shown = listed.slice(0, 8)
    // One column for the PR and who has it, as wide as the widest row needs, so the rows line up.
    const widest = Math.max(0, ...shown.map((r) => right(r, s).len))
    const rightW = W - 25 - widest - 2 >= 24 ? widest : 0 // a full column only when titles keep 24 characters
    for (const r of shown) out.push(workLine(r, W, s, rightW))
    if (listed.length > shown.length) out.push(dim(s, `  +${listed.length - shown.length} more on the dashboard`))
    if (w.bugsNotStarted.length) {
      const list = w.bugsNotStarted.map((b) => `#${b.number} ${b.title}`).join(' · ')
      out.push(fg(s, 203, '  Bugs not started: ') + dim(s, fit(list, Math.max(0, W - 20), 'left').trimEnd()))
    }
    out.push('')
  }
  return out
}

// The PR and who has it. Compact, for narrow terminals: "PR #6012 ✗", with a conflict spelled out.
function right(r: WorkRow, s: Style, compact = false): { text: string; len: number } {
  const bits: [number, string][] = []
  if (r.pr) {
    const mark: [number, string] | undefined = r.pr.checks === 'success' ? [71, '✓'] : r.pr.checks === 'failure' ? [203, '✗'] : r.pr.checks === 'pending' ? [179, '…'] : undefined
    if (compact) {
      bits.push([245, `PR #${r.pr.number}`])
      if (mark) bits[0] = [mark[0], `PR #${r.pr.number} ${mark[1]}`]
      if (r.pr.mergeable === 'conflicting') bits.push([203, 'conflict'])
    } else {
      bits.push([245, `PR #${r.pr.number}`])
      if (r.pr.draft) bits.push([245, 'draft'])
      if (mark) bits.push([mark[0], mark[1] + ' checks'])
      if (r.pr.mergeable === 'conflicting') bits.push([203, '✗ conflict'])
    }
  }
  if (r.who && !compact) bits.push([245, '@' + r.who])
  return { text: bits.map(([c, t]) => fg(s, c, t)).join(dim(s, ' · ')), len: bits.reduce((n, [, t]) => n + t.length, 0) + Math.max(0, bits.length - 1) * 3 }
}

function workLine(r: WorkRow, W: number, s: Style, rightW: number): string {
  const lead = '  ' + fit('#' + r.number, 7, 'left') + (r.bug ? fg(s, 203, 'bug ') : '    ') + fg(s, STAGE_FG[r.stage], fit(STAGE_WORD[r.stage], 12, 'left'))
  const titleW = W - 25 - (rightW ? rightW + 2 : 0)
  const rt = right(r, s)
  if (titleW < 14 || rt.len > rightW) {
    // Too narrow for the full column: the title, then the PR in short.
    const c = right(r, s, true)
    const t = fit(r.title, Math.max(0, W - 25 - (c.len ? c.len + 2 : 0)), 'left')
    return lead + (c.len ? t + '  ' + c.text : t.trimEnd())
  }
  return lead + fit(r.title, titleW, 'left') + (rightW ? '  ' + rt.text : '')
}

function nowView(snap: Snapshot, W: number, s: Style, now: number): string[] {
  const out: string[] = []
  const decisions = snap.live.decisions
  // Phases strip: two lines per box, the gate under it.
  const phases = snap.live.phases
  const gates = gated(phases, decisions)
  const pw = Math.max(5, Math.floor((W - (phases.length - 1)) / phases.length))
  const toneP = (p: PhaseState): Tone => (gates.has(p.name) ? 'need' : toneOf(p.status))
  // Only once a harness reports phases: nine boxes all saying "waiting" tell you nothing.
  if (phases.some((p) => p.status !== 'waiting')) {
    out.push(bold(s, 'Product phases'))
    out.push(phases.map((p) => paint(s, toneP(p), fit(p.name, pw))).join(' '))
    out.push(phases.map((p) => paint(s, toneP(p), fit(gates.has(p.name) ? 'waits on you' : PHASE_WORD[p.status] ?? p.status, pw))).join(' '))
    out.push(phases.map((p) => paint(s, toneP(p), fit(p.skill ?? '', pw))).join(' '))
  }
  // Skills running now, with who runs them: one line under the phases.
  const busy = snap.live.agents.filter((a) => a.status === 'busy')
  if (busy.length) {
    const bySkill = new Map<string, string[]>()
    for (const a of busy) bySkill.set(a.skill ?? 'no skill', [...(bySkill.get(a.skill ?? 'no skill') ?? []), `${role(a.role)}${laneOfKey(a.key) ? ' ' + laneOfKey(a.key) : ''}`])
    const line = [...bySkill].map(([k, who]) => fg(s, 183, k) + ` ×${who.length} ` + dim(s, '(' + who.join(', ') + ')')).join('   ')
    out.push(bold(s, 'Skills running ') + (visible(line) <= W - 15 ? line : [...bySkill].map(([k, who]) => fg(s, 183, k) + ` ×${who.length}`).join('   ')))
  }
  if (out.length) out.push('')

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
      if (cur?.status === 'running') {
        // The running agent in one line: skill, model, time on the step, budget, what it is doing now.
        const t = cur.tokens
        const pct = t?.used && t?.budget ? Math.round((t.used / t.budget) * 100) : undefined
        const n = pct == null ? 0 : Math.round(Math.min(pct, 100) / 20)
        const meter = pct == null ? '' : fg(s, pct >= 80 ? 214 : 75, '█'.repeat(n) + '░'.repeat(5 - n)) + dim(s, ` ${kTok(t!.used!)}/${kTok(t!.budget!)} · `)
        const bits = [cur.skill, cur.agent?.model, cur.startedAt ? since(cur.startedAt, now) : ''].filter(Boolean)
        const lead = dim(s, '↳ ' + (bits.length ? bits.join(' · ') + ' · ' : ''))
        const room = W - labelW - 1 - visible(lead) - visible(meter)
        out.push(' '.repeat(labelW) + ' ' + lead + meter + dim(s, fit(cur.detail ?? '', Math.max(0, room), 'left').trimEnd()))
      } else {
        out.push('')
      }
    }
    out.push('')
  }
  out.push(...githubNow(snap, W, s))
  if (!rows.length) {
    const hint = 'Agent lanes appear here once your harness reports steps (hh step) or tool hooks are set up: docs/INTEGRATIONS.md'
    const short = 'Agent lanes: see docs/INTEGRATIONS.md'
    out.push(dim(s, hint.length <= W ? hint : fit(short, W, 'left').trimEnd()), '')
  }

  // Idle agents on one line.
  const idle = snap.live.agents.filter((a) => a.status !== 'busy')
  if (idle.length) {
    const byRole = new Map<string, string[]>()
    for (const a of idle) byRole.set(a.role, [...(byRole.get(a.role) ?? []), laneOfKey(a.key)])
    out.push(dim(s, fit('Idle: ' + [...byRole].map(([r, ls]) => `${role(r)}${ls.filter(Boolean).length ? ' ' + ls.filter(Boolean).join(',') : ''}`).join(' · '), W, 'left').trimEnd()), '')
  }
  return out
}

const since = (iso: string, now: number) => {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  return sec < 3600 ? mmss(sec) : `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`
}
const kTok = (n: number) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n))
const laneOfKey = (key: string) => { const l = key.split(':').at(-2); return l && l !== '-' ? l : '' }

// ---------- swimlanes: one row per lane across time, each step a bar colored by the agent's role ----------

const ROLE_BG: Record<string, number> = {
  lead: 61, architect: 61, developer: 29, designer: 132, 'associate-developer': 136, tester: 25, 'qa-lead': 25,
  'design-auditor': 25, 'ui-aligner': 132, coordinator: 240, sre: 166, 'release-lead': 166,
}
const roleBg = (r?: string) => (r && ROLE_BG[r]) || 59
const WINDOWS = [1, 2, 5, 15, 60, 240]

// Where a lane's worktree stands on its way into the base, in one short phrase.
function mergeState(snap: Snapshot, ticket: number | undefined, s: Style): { text: string; plain: string } | undefined {
  if (ticket == null) return undefined
  const wt = snap.git.flatMap((g) => g.worktrees).find((w) => w.ticket === ticket)
  const tracker = snap.trackers[0]
  const branch = wt?.branch
  const pr = tracker?.changes.find((c) => (branch ? c.head === branch : c.ticket === ticket) && c.state === 'open') ?? tracker?.changes.find((c) => (branch ? c.head === branch : c.ticket === ticket))
  if (!wt && !pr) return undefined

  let tail: string
  let color: number
  if (pr?.state === 'merged') { tail = `PR #${pr.number} merged`; color = 141 }
  else if (pr?.mergeable === 'conflicting') { tail = `PR #${pr.number} ✗ conflict`; color = 210 }
  else if (pr?.checks === 'failure') { tail = `PR #${pr.number} ✗ checks red`; color = 210 }
  else if (pr && wt && wt.behind > 0) { tail = `PR #${pr.number} · behind ${wt.behind}`; color = 222 }
  else if (pr?.checks === 'success') { tail = `PR #${pr.number} ✓ merging`; color = 114 }
  else if (pr) { tail = `PR #${pr.number} ◌ checks`; color = 117 }
  else { tail = wt && wt.ahead ? 'no PR yet' : 'no commits yet'; color = 245 }
  return { plain: tail, text: fg(s, color, tail) }
}

// The lane's local worktree in one line: branch, ahead and behind the base, uncommitted changes, last commit,
// and the way into the base in words.
function localLine(snap: Snapshot, ticket: number | undefined, s: Style, now: number, width: number): string | undefined {
  if (ticket == null) return undefined
  const g = snap.git.find((x) => x.worktrees.some((w) => w.ticket === ticket))
  const wt = g?.worktrees.find((w) => w.ticket === ticket)
  if (!g || !wt) return undefined
  const base = g.base.replace(/^origin\//, '')
  const tracker = snap.trackers[0]
  const pr = tracker?.changes.find((c) => c.head === wt.branch && c.state === 'open') ?? tracker?.changes.find((c) => c.head === wt.branch)
  const conflict = pr?.mergeable === 'conflicting'
  const committed = (iso?: string) => {
    if (!iso) return ''
    const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
    return m < 1 ? 'committed just now' : m < 60 ? `committed ${m} min ago` : `committed ${Math.floor(m / 60)} h ago`
  }
  const way = pr?.state === 'merged' ? `merged into ${base}`
    : conflict ? `merges ${base} in to fix the conflict`
    : pr && wt.behind ? `merges ${base} in first`
    : pr?.checks === 'success' ? `merges into ${base} when checks pass`
    : !pr && wt.ahead ? 'not pushed yet' : ''
  // Most important first; the line drops parts from the end until it fits.
  const parts = [
    fg(s, conflict ? 210 : wt.behind ? 222 : 114, wt.branch),
    `${wt.ahead} ahead · ` + (wt.behind ? fg(s, 222, `${wt.behind} behind`) : '0 behind'),
    wt.dirty ? fg(s, 222, 'uncommitted changes') : 'clean',
    committed(wt.lastCommitAt),
    way ? '→ ' + way : '',
  ].filter(Boolean)
  while (parts.length > 2 && visible(dim(s, '└ ') + parts.join(dim(s, ' · '))) > width) parts.pop()
  const line = dim(s, '└ ') + parts.join(dim(s, ' · '))
  return visible(line) <= width ? line : dim(s, fit(line.replace(/\x1b\[[0-9;]*m/g, ''), width, 'left').trimEnd())
}

export function flowView(snap: Snapshot, W: number, s: Style, now: number): string[] {
  const out: string[] = []
  const segs = snap.live.segments
  const rows = snap.live.rows
  // Lanes come from the steps and from the worktrees, so a lane with a branch but no recent step still shows.
  const laneTicket = new Map<string, number | undefined>()
  for (const g of segs) laneTicket.set(g.lane, g.ticket ?? laneTicket.get(g.lane))
  for (const w of snap.git.flatMap((g) => g.worktrees)) {
    if (w.ticket == null) continue
    const lane = rows.find((r) => r.ticket === w.ticket)?.lane ?? '#' + w.ticket
    if (!laneTicket.has(lane)) laneTicket.set(lane, w.ticket)
  }
  // The ticket a lane is on now is the one in its latest step.
  for (const lane of laneTicket.keys()) {
    const last = [...segs].reverse().find((g) => g.lane === lane && g.ticket != null)
    if (last) laneTicket.set(lane, last.ticket)
  }
  if (!laneTicket.size) return out

  const recent = segs.map((g) => Date.parse(g.start)).filter((t) => t >= now - 240 * 60_000)
  const earliest = recent.length ? Math.min(...recent) : now - 60_000
  const mins = WINDOWS.find((m) => now - earliest <= m * 60_000 * 0.95) ?? WINDOWS[WINDOWS.length - 1]!
  const t0 = now - mins * 60_000
  const visibleSegs = segs.filter((g) => (g.end ? Date.parse(g.end) : now) >= t0)
  const lanes = [...laneTicket.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const states = new Map(lanes.map((l) => [l, mergeState(snap, laneTicket.get(l), s)]))
  const LW = 16
  const RW = Math.min(26, Math.max(12, ...[...states.values()].map((m) => (m ? m.plain.length : 0)))) + 2
  const T = Math.max(20, W - LW - 1 - RW - 1)
  const x = (t: number) => Math.min(T - 1, Math.max(0, Math.floor(((t - t0) / (now - t0)) * (T - 1))))
  const clock = (t: number) => new Date(t).toLocaleTimeString([], mins <= 5 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' })
  const base = snap.git[0]

  // The title says as much as the width allows.
  const titleBits = [`Flow · last ${mins >= 60 ? mins / 60 + ' h' : mins + ' min'}`, base ? ' · base ' + base.base : '', ' · each bar is one step, colored by agent; each lane ends with where its branch stands']
  let title = bold(s, titleBits[0]!)
  if (base && visible(title) + titleBits[1]!.length <= W) title += dim(s, ' · base ') + fg(s, 141, base.base)
  if (visible(title) + titleBits[2]!.length <= W) title += dim(s, titleBits[2]!)
  out.push(title)
  const axis = Array<string>(T).fill(' ')
  for (let i = 0; i < 4; i++) {
    const t = t0 + ((now - t0) * i) / 4
    const label = clock(t)
    const at = x(t)
    for (let j = 0; j < label.length && at + j < T - 4; j++) axis[at + j] = label[j]!
  }
  'now'.split('').forEach((c, j) => (axis[T - 3 + j] = c))
  out.push(' '.repeat(LW + 1) + dim(s, axis.join('')) + ' ' + dim(s, fit('Merge', RW, 'left')))

  for (const lane of lanes) {
    const mine = visibleSegs.filter((g) => g.lane === lane)
    const ticket = laneTicket.get(lane)
    const who = [...mine].reverse().find((g) => g.role && g.role !== 'coordinator' && g.role !== 'lead')?.role ?? mine.at(-1)?.role
    const cells: { bg?: number; ch: string; run?: boolean }[] = Array.from({ length: T }, () => ({ ch: '·' }))
    for (const g of mine) {
      const a = x(Math.max(Date.parse(g.start), t0))
      // A finished step stops one column short, so neighbouring steps stay apart.
      const b = Math.max(a, x(g.end ? Date.parse(g.end) : now) - (g.end ? 1 : 0))
      const bg = g.status === 'failed' ? 52 : g.status === 'skipped' ? undefined : roleBg(g.role)
      const text = ((STEP_LABELS[g.step] ?? g.step) + (g.ticket ? ' #' + g.ticket : '')).slice(0, b - a + 1)
      for (let c = a; c <= b; c++) cells[c] = { bg, ch: text[c - a] ?? ' ', run: !g.end }
      if (g.status === 'skipped') for (let c = a; c <= b; c++) cells[c] = { ch: '-' }
    }
    let bar = ''
    for (const c of cells) bar += c.bg == null ? dim(s, c.ch) : esc(s, `48;5;${c.bg};38;5;${c.run ? 231 : 253}`) + (c.run ? esc(s, '1') : '') + c.ch + reset(s)
    const label = bold(s, fit(lane, 5, 'left')) + dim(s, fit(role(who) || (ticket ? '#' + ticket : ''), LW - 5, 'left'))
    const m = states.get(lane)
    out.push(label + ' ' + bar + fg(s, 203, '▏') + (m ? m.text : ''))
    // Under the lane: its local worktree.
    const local = localLine(snap, ticket, s, now, W - 5)
    if (local) out.push(' '.repeat(5) + local)
  }
  // Role colours, then what the merge phrases mean, wrapped to the width.
  const roles = [...new Set(visibleSegs.map((g) => g.role).filter((r): r is string => !!r))]
  const items = [...roles.map((r) => esc(s, `48;5;${roleBg(r)}`) + '  ' + reset(s) + ' ' + role(r)), esc(s, '48;5;52') + '  ' + reset(s) + ' failed', dim(s, 'bold: running')]
  let line = ''
  for (const it of items) {
    if (line && visible(line) + 2 + visible(it) > W - LW - 1) { out.push(' '.repeat(LW + 1) + line); line = '' }
    line += (line ? '  ' : '') + it
  }
  if (line) out.push(' '.repeat(LW + 1) + line)
  // What the merge phrases mean, wrapped to the width.
  const key = ['└ each lane\'s local worktree: branch, ahead and behind the base, uncommitted changes, last commit, way in']
  let kl = ''
  for (const k of key) {
    if (kl && LW + 1 + kl.length + 3 + k.length > W) { out.push(' '.repeat(LW + 1) + dim(s, kl)); kl = '' }
    kl += (kl ? ' · ' : '') + k
  }
  if (kl) out.push(' '.repeat(LW + 1) + dim(s, fit(kl, W - LW - 1, 'left').trimEnd()))
  out.push('')
  return out
}

// ---------- rotation: the views take turns in the same space ----------

export const ROTATION: readonly View[] = ['now', 'flow']
export const VIEW_NAME: Record<View, string> = { all: 'both', now: 'now', flow: 'flow' }

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
  const out: View[] = ['now']
  if (snap.live.segments.length || snap.git.some((g) => g.worktrees.some((w) => w.ticket != null))) out.push('flow')
  return out
}

export const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

