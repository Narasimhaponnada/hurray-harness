import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Cell, LaneRow, PaneView, Summary, ViewState } from '../types'
import { BUILD_STEPS, STEP_LABEL, TEST_STEPS, VIEW_NAME, availableViews, mmss, rotation, statusLine, summarize } from './summarize.ts'

// hurray-harness for Claude Code: reads the local hub (hh start) every few seconds and shows
//   - a status line: stage, busy lanes, what needs you, milestone progress
//   - a band above the prompt whenever something needs you
//   - a lanes pane beside the chat (/lanes): decisions on top, then the grid, swimlanes and worktree
//     two views taking turns every HH_ROTATE seconds: Now (phases, skills, grid, agents) and Flow
//     (swimlanes with each lane's merge state) (default 120), with buttons to pin one
// No separate terminal needed: when no hub answers, it starts one (hh start) in the session's folder
// for the session's life, and it opens the lanes pane when an interactive session starts.
//   HH_AUTOSTART=0  never start the hub    HH_PANE=off  do not open the pane on start
// Read-only: it only fetches the hub's /api/state.

const PANE = 'hh-lanes'
const POLL_MS = 4000
const summary = atom({ plugin: 'hurray-harness', key: 'summary' } as const, null, { shape: 'summary-1' })
const bandHidden = atom({ plugin: 'hurray-harness', key: 'bandHidden' } as const, false)
// Which view the pane shows: pinned by a button, or null to take turns every HH_ROTATE seconds (default 120).
const view = atom({ plugin: 'hurray-harness', key: 'view' } as const, null, { shape: 'view-1' })
const ROLE_BG: Record<string, string> = {
  lead: '#534AB7', architect: '#534AB7', developer: '#0F6E56', designer: '#993556', 'associate-developer': '#854F0B',
  tester: '#185FA5', 'qa-lead': '#185FA5', 'design-auditor': '#185FA5', 'ui-aligner': '#993556', coordinator: '#5F5E5A', sre: '#993C1D', 'release-lead': '#993C1D',
}
const ROLE_NAME: Record<string, string> = { 'associate-developer': 'assoc dev', 'ui-aligner': 'ui aligner', 'design-auditor': 'design aud', 'qa-lead': 'QA lead', 'release-lead': 'rel lead' }

// Cell colors: a dark chip with light text, readable on dark and light themes.
const TONE: Record<Cell, { bg: string; fg: string }> = {
  done: { bg: '#27500A', fg: '#C0DD97' },
  running: { bg: '#0C447C', fg: '#B5D4F4' },
  failed: { bg: '#791F1F', fg: '#F7C1C1' },
  blocked: { bg: '#633806', fg: '#FAC775' },
  skipped: { bg: '#2C2C2A', fg: '#888780' },
  waiting: { bg: '#2C2C2A', fg: '#888780' },
}

let timer: Timer | undefined
let seen = new Set<string>()
let polling = false
let cwd: string | undefined

// The hub this session started, if any: running while hh start runs, and why it could not start.
const hub: { running: boolean; tried?: number; error?: string } = { running: false }

// hh is a .cmd file on Windows, which only starts through cmd.exe; elsewhere it runs directly.
const STARTS: string[][] = [['hh', 'start'], ['cmd.exe', '/d', '/s', '/c', 'hh start']]

async function startHub($: EngineInterface): Promise<void> {
  if (hub.running || (await $.env.get('HH_AUTOSTART')) === '0') return
  const now = await $.clock.now()
  if (hub.tried !== undefined && now - hub.tried < 30_000) return // at most one try every 30 s
  hub.tried = now
  hub.running = true
  hub.error = undefined
  // A child for the session's life: the loop runs on after this returns, and ends with the hub or
  // with the session.
  void (async () => {
    for (const argv of STARTS) {
      let out = ''
      try {
        for await (const piece of $.process.spawn({ argv, cwd })) out = (out + piece.text).slice(-600)
        const last = out.trim().split(/\r?\n/).filter(Boolean).at(-1)
        hub.error = 'hh start stopped' + (last ? ': ' + last : '')
        break
      } catch {
        hub.error = 'hh is not installed or not on PATH. Install it: npm install -g hurray-harness'
      }
    }
    hub.running = false
    void refresh($)
  })()
}

async function refresh($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const url = ((await $.env.get('HH_URL')) || 'http://127.0.0.1:7311').replace(/\/$/, '')
    const now = await $.clock.now()
    let next: Summary
    try {
      const res = await $.http.fetch(url + '/api/state')
      next = res.ok ? summarize(JSON.parse(res.text), url, now) : offline(url, 'hub answered ' + res.status, now)
    } catch (err) {
      next = offline(url, String((err as Error)?.message ?? err), now)
    }
    if (!next.ok) {
      // Only for the default local hub: a hub at another address is someone else's to start.
      if (!(await $.env.get('HH_URL'))) await startHub($)
      next = { ...next, starting: hub.running, error: hub.running ? undefined : hub.error ?? next.error }
    }
    $.ui.status(statusLine(next))
    // Plain data only: drop undefined fields before the host stores it.
    const plain = JSON.parse(JSON.stringify(next)) as Summary
    await update($, summary, () => plain)
    // A new decision raises a toast once and brings the band back.
    const fresh = next.decisions.filter((d) => !seen.has(d.id))
    seen = new Set(next.decisions.map((d) => d.id))
    if (fresh.length) {
      $.ui.toast('Needs you: ' + fresh[0]!.title + (fresh.length > 1 ? ` (+${fresh.length - 1})` : ''))
      await update($, bandHidden, () => false)
    }
  } catch {
    // The session is ending or the host refused a write: the next tick tries again.
  } finally {
    polling = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({ name: 'lanes', description: 'Show agent lanes from hurray-harness beside the chat' })
    timer?.cancel()
    timer = $.clock.every(POLL_MS, () => void refresh($))
    // Each session starts the rotation at the grid.
    const now = await $.clock.now()
    await update($, view, (prev) => ({ pinned: prev?.pinned ?? null, start: now }))
    await refresh($)
    // The lanes pane, beside the chat from the start, so no separate terminal is needed.
    if (e.isInteractive && (await $.env.get('HH_PANE')) !== 'off') {
      try { await $.ui.open({ id: PANE, title: 'Agent lanes' }) } catch { /* this surface has no panes */ }
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = undefined
    $.ui.status(undefined)
    return next(e)
  })

  on('command.run', { command: 'lanes' }, async ($) => {
    const opened = await $.ui.open({ id: PANE, title: 'Agent lanes' })
    await refresh($)
    const s = await read($, summary)
    return { text: opened.isPlaced ? 'Lanes pane opened.' : statusLine(s) + (s?.ok ? ' · dashboard: ' + s.url : '') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, summary)
    if (e.props.hasSurvey || !s?.ok || !s.decisions.length || (await read($, bandHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const first = s.decisions[0]!
    return (
      <Box flexDirection="row" gap={1}>
        <Text color="warning" weight="medium">Needs you ({s.decisions.length})</Text>
        <Text color="warning">{first.title}{first.why ? ' · ' + first.why : ''}</Text>
        <Button key="lanes" label="Lanes" onPress={() => void $.ui.open({ id: PANE, title: 'Agent lanes' })} />
        <Button key="hide" label="Hide" onPress={() => update($, bandHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const s = await read($, summary)
    if (!s) return <Text dimColor>Connecting to the hub…</Text>
    if (!s.ok) {
      if (s.starting) return <Text dimColor>Starting the hub in this folder (hh start)…</Text>
      return (
        <Box flexDirection="column">
          <Text color="warning">The hub is not running at {s.url}.</Text>
          {s.error ? <Text>{s.error}</Text> : null}
          <Text dimColor>To start it yourself, run hh start in your repo. It starts on its own unless HH_AUTOSTART=0.</Text>
        </Box>
      )
    }
    const nowMs = await $.clock.now()
    const kt = (n: number) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n))
    const meter = (used: number, budget: number) => {
      const n = Math.round(Math.min(100, (used / budget) * 100) / 20)
      return '█'.repeat(n) + '░'.repeat(5 - n) + ` ${kt(used)}/${kt(budget)}`
    }
    const bar = (n: number, of: number, width = 20) => {
      const fill = of ? Math.round((n / of) * width) : 0
      return '█'.repeat(fill) + '░'.repeat(width - fill)
    }
    // Fixed-width colored cells, sized to the pane: the same grid as the browser dashboard.
    const cols = Math.max(60, e.props.bodyColumns ?? 100)
    const fit = (t: string, w: number, center = true) => {
      const v = t.length > w ? t.slice(0, Math.max(0, w - 1)) + '…' : t
      if (!center) return v + ' '.repeat(w - v.length)
      const l = Math.floor((w - v.length) / 2)
      return ' '.repeat(l) + v + ' '.repeat(w - v.length - l)
    }
    const chip = (key: string, c: Cell, text: string, w: number, center = true) => (
      <Text key={key} mono color={TONE[c].fg} backgroundColor={TONE[c].bg}>{fit(text, w, center)}</Text>
    )
    // In a narrow pane, agent names shrink rather than lose their ends.
    const SHORT: Record<string, string> = { developer: 'dev', coordinator: 'coord', architect: 'arch', 'ui aligner': 'ui align', 'assoc dev': 'assoc', 'design aud': 'design', designer: 'design' }
    const narrow = (t: string, w: number) => (t.length > w ? SHORT[t] ?? t : t)
    const labelW = Math.min(20, Math.max(12, Math.floor(cols * 0.17)))
    const grid = (title: string, steps: string[], rows: LaneRow[]) => {
      const cw = Math.max(7, Math.floor((cols - labelW - steps.length) / steps.length))
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="medium">{title}</Text>
          <Box flexDirection="row" gap={1}>
            <Text mono>{' '.repeat(labelW - 1)}</Text>
            {steps.map((st) => <Text key={st} mono dimColor>{fit(STEP_LABEL[st] ?? st, cw)}</Text>)}
          </Box>
          {rows.map((r) => (
            <Box key={r.key} flexDirection="column" marginBottom={r.doing ? 0 : 1}>
              <Box flexDirection="row" gap={1}>
                <Text mono weight="medium">{fit(`#${r.ticket} ${r.title ?? ''}`, labelW - 1, false)}</Text>
                {r.cells.map((c, i) => chip('t' + i, c, r.words[i]?.[0] ?? '', cw))}
              </Box>
              <Box flexDirection="row" gap={1}>
                <Text mono dimColor>{fit(r.lane ?? '', labelW - 1, false)}</Text>
                {r.cells.map((c, i) => chip('b' + i, c, narrow(r.words[i]?.[1] ?? '', cw), cw))}
              </Box>
              {r.doing ? (
                <Box flexDirection="row">
                  <Text dimColor>{' '.repeat(labelW)}↳ {[r.skill, r.model, r.since ? mmss(Math.max(0, Math.round((nowMs - r.since) / 1000))) : ''].filter(Boolean).join(' · ')} · </Text>
                  {r.used && r.budget ? <Text color={r.used / r.budget >= 0.8 ? 'warning' : '#85B7EB'}>{meter(r.used, r.budget)} </Text> : null}
                  <Text dimColor>{r.doing}</Text>
                </Box>
              ) : null}
            </Box>
          ))}
        </Box>
      )
    }
    const pw = Math.max(9, Math.floor((cols - (s.phases.length - 1)) / Math.max(1, s.phases.length)))

    // Which view to show now: a pinned one, or the turn of the rotation.
    const period = Number((await $.env.get('HH_ROTATE')) ?? 120)
    const vs = (await read($, view)) as ViewState | null
    const avail = availableViews(s)
    const rot = rotation(vs?.start ?? 0, nowMs, Number.isFinite(period) ? period : 120, avail)
    const shown: PaneView = vs?.pinned ?? rot.view
    const footer = vs?.pinned ? `${VIEW_NAME[shown]} · pinned` : rot.next === rot.view ? VIEW_NAME[shown] : `${VIEW_NAME[shown]} · ${VIEW_NAME[rot.next]} in ${mmss(rot.remainingSec)}`

    // Flow: swimlanes, each lane's row ending with where its branch stands on merging.
    const mergeOf = (ticket?: number) => {
      const w = s.worktrees.find((x) => ticket != null && x.branch.match(new RegExp('(^|/)' + ticket + '[-_/]')))
      if (!w) return undefined
      if (w.merged) return { tail: `PR #${w.pr} merged`, color: '#AFA9EC' }
      if (w.conflict) return { tail: `PR #${w.pr} ✗ conflict`, color: 'error' }
      if (w.pr && w.checks === 'failure') return { tail: `PR #${w.pr} ✗ checks red`, color: 'error' }
      if (w.pr && w.behind > 0) return { tail: `PR #${w.pr} · behind ${w.behind}`, color: 'warning' }
      if (w.pr && w.checks === 'success') return { tail: `PR #${w.pr} ✓ merging`, color: 'success' }
      if (w.pr) return { tail: `PR #${w.pr} ◌ checks`, color: '#85B7EB' }
      return { tail: w.ahead ? 'no PR yet' : 'no commits yet', color: undefined }
    }
    // Under each lane: its local worktree (branch, ahead and behind, uncommitted changes, last commit, way in).
    const localLine = (w: Summary['worktrees'][number]) => {
      const base = (s.base ?? 'base').replace(/^origin\//, '')
      const mins = w.lastCommitAt ? Math.max(0, Math.round((nowMs - w.lastCommitAt) / 60_000)) : undefined
      const committed = mins == null ? '' : mins < 1 ? 'committed just now' : mins < 60 ? `committed ${mins} min ago` : `committed ${Math.floor(mins / 60)} h ago`
      const way = w.merged ? `merged into ${base}` : w.conflict ? `merges ${base} in to fix the conflict` : w.pr && w.behind ? `merges ${base} in first` : w.pr && w.checks === 'success' ? `merges into ${base} when checks pass` : !w.pr && w.ahead ? 'not pushed yet' : ''
      return (
        <Box flexDirection="row">
          <Text mono dimColor>{'     └ '}</Text>
          <Text mono color={w.conflict ? 'error' : w.behind ? 'warning' : 'success'}>{w.branch}</Text>
          <Text mono dimColor> · {w.ahead} ahead · </Text>
          <Text mono color={w.behind ? 'warning' : undefined} dimColor={!w.behind}>{w.behind} behind</Text>
          <Text mono dimColor> · </Text>
          <Text mono color={w.dirty ? 'warning' : undefined} dimColor={!w.dirty}>{w.dirty ? 'uncommitted changes' : 'clean'}</Text>
          <Text mono dimColor>{committed ? ' · ' + committed : ''}{way ? ' · → ' + way : ''}</Text>
        </Box>
      )
    }
    const flow = () => {
      const segs = s.segments
      // Lanes from the steps, plus worktrees whose lane has no recent step.
      const laneTicket = new Map<string, number | undefined>()
      for (const g of segs) laneTicket.set(g.lane, g.ticket ?? laneTicket.get(g.lane))
      for (const w of s.worktrees) {
        const t = Number(w.branch.match(/(?:^|\/)(\d+)[-_/]/)?.[1])
        if (!Number.isFinite(t)) continue
        const lane = w.lane ?? '#' + t
        if (!laneTicket.has(lane)) laneTicket.set(lane, t)
      }
      const recent = segs.map((g) => g.start)
      const earliest = recent.length ? Math.min(...recent) : nowMs - 60_000
      const mins = [1, 2, 5, 15, 60, 240].find((m) => nowMs - earliest <= m * 60_000 * 0.95) ?? 240
      const t0 = nowMs - mins * 60_000
      const LW = 16
      const RW = 26
      const T = Math.max(20, cols - LW - RW - 2)
      const x = (t: number) => Math.min(T - 1, Math.max(0, Math.floor(((t - t0) / (nowMs - t0)) * (T - 1))))
      const lanes = [...laneTicket.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="medium">Flow · last {mins >= 60 ? mins / 60 + ' h' : mins + ' min'}{s.base ? ' · base ' + s.base : ''} · each bar is one step, colored by agent; each lane ends with its merge state</Text>
          {lanes.map((lane) => {
            const mine = segs.filter((g) => g.lane === lane)
            const ticket = [...mine].reverse().find((g) => g.ticket != null)?.ticket ?? laneTicket.get(lane)
            const who = [...mine].reverse().find((g) => g.role && g.role !== 'coordinator' && g.role !== 'lead')?.role ?? mine.at(-1)?.role
            const cells: { bg?: string; ch: string }[] = Array.from({ length: T }, () => ({ ch: '·' }))
            for (const g of mine) {
              const a = x(Math.max(g.start, t0))
              // A finished step stops one column short, so neighbouring steps stay apart.
              const b = Math.max(a, x(g.end ?? nowMs) - (g.end ? 1 : 0))
              const bg = g.status === 'failed' ? '#A32D2D' : g.status === 'skipped' ? undefined : ROLE_BG[g.role ?? ''] ?? '#444441'
              const text = ((STEP_LABEL[g.step] ?? g.step) + (g.ticket ? ' #' + g.ticket : '')).slice(0, b - a + 1)
              for (let c = a; c <= b; c++) cells[c] = { bg, ch: text[c - a] ?? ' ' }
            }
            const runs: { bg?: string; text: string }[] = []
            for (const c of cells) {
              const last = runs.at(-1)
              if (last && last.bg === c.bg) last.text += c.ch
              else runs.push({ bg: c.bg, text: c.ch })
            }
            const m = mergeOf(ticket)
            const w = s.worktrees.find((x) => ticket != null && x.branch.match(new RegExp('(^|/)' + ticket + '[-_/]')))
            return (
              <Box key={lane} flexDirection="column">
              <Box flexDirection="row">
                <Text mono weight="medium">{fit(lane, 5, false)}</Text>
                <Text mono dimColor>{fit(ROLE_NAME[who ?? ''] ?? who ?? (ticket ? '#' + ticket : ''), LW - 5, false)} </Text>
                {runs.map((r, i) => r.bg ? <Text key={String(i)} mono color="#F1EFE8" backgroundColor={r.bg}>{r.text}</Text> : <Text key={String(i)} mono dimColor>{r.text}</Text>)}
                <Text mono color="error">▏</Text>
                {m ? <Text mono color={m.color}>{m.tail}</Text> : null}
              </Box>
              {w ? localLine(w) : null}
              </Box>
            )
          })}
          <Box flexDirection="row" gap={2} marginTop={1}>
            {[...new Set(segs.map((g) => g.role).filter((r): r is string => !!r))].map((r) => (
              <Text key={r} mono><Text backgroundColor={ROLE_BG[r] ?? '#444441'}>{'  '}</Text> {ROLE_NAME[r] ?? r}</Text>
            ))}
            <Text mono><Text backgroundColor="#A32D2D">{'  '}</Text> failed</Text>
          </Box>
          <Text dimColor>└ each lane's local worktree: branch, ahead and behind the base, uncommitted changes, last commit, way in</Text>
        </Box>
      )
    }

    // Now: skills running, then (after the grid) idle agents.
    const skillsLine = () => {
      const bySkill = new Map<string, string[]>()
      for (const a of s.agents) bySkill.set(a.skill ?? 'no skill', [...(bySkill.get(a.skill ?? 'no skill') ?? []), `${ROLE_NAME[a.role] ?? a.role}${a.lane ? ' ' + a.lane : ''}`])
      if (!bySkill.size) return null
      return (
        <Box flexDirection="row" gap={1}>
          <Text weight="medium">Skills running</Text>
          {[...bySkill].map(([k, who]) => <Text key={k}><Text color="#AFA9EC">{k}</Text> ×{who.length} <Text dimColor>({who.join(', ')})</Text></Text>)}
        </Box>
      )
    }
    // What the tracker has in flight, with its PR and who has it: shown with or without agent lanes.
    const STAGE: Record<string, [string, string]> = { blocked: ['blocked', 'warning'], working: ['in progress', '#85B7EB'], review: ['in review', '#AFA9EC'], qa: ['in QA', '#EF9F27'] }
    const githubNow = () => {
      const g = s.github
      if (!g) return null
      const TW = Math.max(14, cols - 26 - (cols >= 90 ? 34 : 14))
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text><Text weight="medium">Now on GitHub</Text><Text dimColor> · {g.summary}</Text></Text>
          {g.rows.length ? null : <Text dimColor>  Nothing in progress, in review, in QA or blocked.</Text>}
          {g.rows.map((r) => {
            const [word, color] = STAGE[r.stage] ?? [r.stage, 'subtle']
            const mark = r.checks === 'success' ? '✓' : r.checks === 'failure' ? '✗' : r.checks === 'pending' ? '…' : ''
            const prText = r.pr ? (cols >= 90 ? `PR #${r.pr}${mark ? ' · ' + mark + ' checks' : ''}${r.conflict ? ' · ✗ conflict' : ''}` : `PR #${r.pr}${mark ? ' ' + mark : ''}${r.conflict ? ' · conflict' : ''}`) : ''
            return (
              <Box key={'gh' + r.number} flexDirection="row">
                <Text mono>{fit('  #' + r.number, 9, false)}</Text>
                <Text mono color="error">{r.bug ? 'bug ' : '    '}</Text>
                <Text mono color={color}>{fit(word, 12, false)}</Text>
                <Text mono>{fit(r.title, TW, false)}</Text>
                {prText ? <Text mono color={r.checks === 'failure' || r.conflict ? 'error' : 'subtle'}>{'  ' + prText}</Text> : null}
                {r.who && cols >= 90 ? <Text mono dimColor>{'  @' + r.who}</Text> : null}
              </Box>
            )
          })}
          {g.more ? <Text dimColor>  +{g.more} more on the dashboard</Text> : null}
          {g.bugsNotStarted.length ? <Text><Text color="error">  Bugs not started: </Text><Text dimColor>{g.bugsNotStarted.join(' · ')}</Text></Text> : null}
        </Box>
      )
    }
    const idleLine = () => (s.idle.length ? <Box marginTop={1}><Text dimColor>Idle: {s.idle.map((r) => `${ROLE_NAME[r.role] ?? r.role}${r.lanes.length ? ' ' + r.lanes.join(',') : ''}`).join(' · ')}</Text></Box> : null)

    const pick = (v: PaneView | null) => update($, view, (prev) => ({ pinned: v, start: v ? prev?.start ?? nowMs : nowMs }))
    return (
      <Box flexDirection="column">
        <Text weight="medium">{[s.repo, s.milestone ? 'milestone ' + s.milestone : '', s.stage].filter(Boolean).join(' · ')}</Text>
        {s.total ? <Text mono>{bar(s.done, s.total)} {s.done}/{s.total} done</Text> : null}

        {s.decisions.length ? (
          <Box flexDirection="column" marginTop={1}>
            {chip('dh', 'blocked', ` Needs your decision (${s.decisions.length})`, cols, false)}
            {s.decisions.slice(0, 4).map((d) => chip(d.id, 'blocked', `   ${d.title}${d.why ? ' · ' + d.why : ''}`, cols, false))}
          </Box>
        ) : null}

        {shown === 'now' && s.phases.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text weight="medium">Product phases</Text>
            <Box flexDirection="row" gap={1}>{s.phases.map((p) => chip('pn' + p.name, p.tone, p.name, pw))}</Box>
            <Box flexDirection="row" gap={1}>{s.phases.map((p) => chip('pw' + p.name, p.tone, p.word, pw))}</Box>
            <Box flexDirection="row" gap={1}>{s.phases.map((p) => chip('ps' + p.name, p.tone, p.skill ?? '', pw))}</Box>
          </Box>
        ) : null}
        {shown === 'now' ? skillsLine() : null}
        {shown === 'now' && s.build.length ? grid(`Tickets in flight · ${s.busy} busy · each cell shows status and the agent on it`, BUILD_STEPS, s.build) : null}
        {shown === 'now' && s.test.length ? grid('Test lanes', TEST_STEPS, s.test) : null}
        {shown === 'now' ? idleLine() : null}
        {shown === 'now' ? githubNow() : null}
        {shown === 'now' && !s.build.length && !s.test.length ? <Box marginTop={1}><Text dimColor>Agent lanes appear here once your harness reports steps (hh step) or tool hooks are set up.</Text></Box> : null}
        {shown === 'flow' ? flow() : null}

        <Box flexDirection="row" gap={1} marginTop={1}>
          {chip('l1', 'done', 'Done', 6)}{chip('l2', 'running', 'Working now', 13)}{chip('l3', 'failed', 'Failed, recode', 16)}
          {chip('l4', 'blocked', 'Needs you', 11)}{chip('l5', 'waiting', 'Not reached', 13)}
          <Text dimColor>full dashboard: {s.url}</Text>
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text dimColor>{footer}</Text>
          <Button key="v-now" label="Now" onPress={() => pick('now')} />
          {avail.includes('flow') ? <Button key="v-flow" label="Flow" onPress={() => pick('flow')} /> : null}
          {vs?.pinned ? <Button key="v-rotate" label="Rotate" onPress={() => pick(null)} /> : null}
        </Box>
      </Box>
    )
  })
}

function offline(url: string, error: string, at: number): Summary {
  return { ok: false, error, at, url, done: 0, total: 0, busy: 0, decisions: [], phases: [], build: [], test: [], worktrees: [], segments: [], agents: [], idle: [] }
}
