import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Cell, LaneRow, PaneView, Summary, ViewState } from '../types'
import { BUILD_STEPS, STEP_LABEL, TEST_STEPS, VIEW_NAME, availableViews, mmss, rotation, statusLine, summarize } from './summarize.ts'

// hurray-harness for Claude Code: reads the local hub (hh start) every few seconds and shows
//   - a status line: stage, busy lanes, what needs you, milestone progress
//   - a band above the prompt whenever something needs you
//   - a lanes pane beside the chat (/lanes): decisions on top, then the grid, swimlanes and worktree
//     graph taking turns every HH_ROTATE seconds (default 120), with buttons to pin one
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
    await $.command.register({ name: 'lanes', description: 'Show agent lanes from hurray-harness beside the chat' })
    timer?.cancel()
    timer = $.clock.every(POLL_MS, () => void refresh($))
    // Each session starts the rotation at the grid.
    const now = await $.clock.now()
    await update($, view, (prev) => ({ pinned: prev?.pinned ?? null, start: now }))
    void refresh($)
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
      return (
        <Box flexDirection="column">
          <Text color="warning">The hub is not running at {s.url}.</Text>
          <Text dimColor>Start it in your repo: hh start</Text>
          {s.error ? <Text dimColor>{s.error}</Text> : null}
        </Box>
      )
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
              {r.doing ? <Text dimColor>{' '.repeat(labelW)}↳ {[r.skill, r.model].filter(Boolean).join(' · ')}{r.skill || r.model ? ' · ' : ''}{r.doing}</Text> : null}
            </Box>
          ))}
        </Box>
      )
    }
    const pw = Math.max(9, Math.floor((cols - (s.phases.length - 1)) / Math.max(1, s.phases.length)))

    // Which view to show now: a pinned one, or the turn of the rotation.
    const period = Number((await $.env.get('HH_ROTATE')) ?? 120)
    const vs = (await read($, view)) as ViewState | null
    const nowMs = await $.clock.now()
    const avail = availableViews(s)
    const rot = rotation(vs?.start ?? 0, nowMs, Number.isFinite(period) ? period : 120, avail)
    const shown: PaneView = vs?.pinned ?? rot.view
    const footer = vs?.pinned ? `${VIEW_NAME[shown]} · pinned` : rot.next === rot.view ? VIEW_NAME[shown] : `${VIEW_NAME[shown]} · ${VIEW_NAME[rot.next]} in ${mmss(rot.remainingSec)}`

    // Swimlanes: one row per lane across time, runs of the same step drawn as one colored bar.
    const swim = () => {
      const segs = s.segments
      const recent = segs.map((g) => g.start)
      const earliest = recent.length ? Math.min(...recent) : nowMs - 60_000
      const mins = [1, 2, 5, 15, 60, 240].find((m) => nowMs - earliest <= m * 60_000 * 0.95) ?? 240
      const t0 = nowMs - mins * 60_000
      const LW = 16
      const T = Math.max(20, cols - LW - 2)
      const x = (t: number) => Math.min(T - 1, Math.max(0, Math.floor(((t - t0) / (nowMs - t0)) * (T - 1))))
      const lanes = [...new Set(segs.map((g) => g.lane))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="medium">Swimlanes · last {mins >= 60 ? mins / 60 + ' h' : mins + ' min'} · each bar is one step, colored by agent</Text>
          {lanes.map((lane) => {
            const mine = segs.filter((g) => g.lane === lane)
            const who = [...mine].reverse().find((g) => g.role && g.role !== 'coordinator' && g.role !== 'lead')?.role ?? mine.at(-1)?.role
            const cells: { bg?: string; ch: string }[] = Array.from({ length: T }, () => ({ ch: '·' }))
            for (const g of mine) {
              const a = x(Math.max(g.start, t0))
              const b = Math.max(a, x(g.end ?? nowMs))
              const bg = g.status === 'failed' ? '#A32D2D' : g.status === 'skipped' ? undefined : ROLE_BG[g.role ?? ''] ?? '#444441'
              const text = ((STEP_LABEL[g.step] ?? g.step) + (g.ticket ? ' #' + g.ticket : '')).slice(0, b - a + 1)
              for (let c = a; c <= b; c++) cells[c] = { bg, ch: text[c - a] ?? ' ' }
            }
            // Merge neighbouring cells of one colour into one piece of text.
            const runs: { bg?: string; text: string }[] = []
            for (const c of cells) {
              const last = runs.at(-1)
              if (last && last.bg === c.bg) last.text += c.ch
              else runs.push({ bg: c.bg, text: c.ch })
            }
            return (
              <Box key={lane} flexDirection="row">
                <Text mono weight="medium">{fit(lane, 5, false)}</Text>
                <Text mono dimColor>{fit(ROLE_NAME[who ?? ''] ?? who ?? '', LW - 5, false)} </Text>
                {runs.map((r, i) => r.bg ? <Text key={String(i)} mono color="#F1EFE8" backgroundColor={r.bg}>{r.text}</Text> : <Text key={String(i)} mono dimColor>{r.text}</Text>)}
                <Text mono color="error">▏</Text>
              </Box>
            )
          })}
          <Box flexDirection="row" gap={2} marginTop={1}>
            {[...new Set(segs.map((g) => g.role).filter((r): r is string => !!r))].map((r) => (
              <Text key={r} mono><Text backgroundColor={ROLE_BG[r] ?? '#444441'}>{'  '}</Text> {ROLE_NAME[r] ?? r}</Text>
            ))}
            <Text mono><Text backgroundColor="#A32D2D">{'  '}</Text> failed</Text>
          </Box>
        </Box>
      )
    }

    // Worktrees to merge: each lane's branch off the base, its commits, PR, checks and way into the base.
    const tree = () => {
      const base = (s.base ?? 'base').replace(/^origin\//, '')
      const nameW = Math.min(30, Math.max(14, ...s.worktrees.map((w) => w.branch.length)))
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="medium">Worktrees to merge · work reaches the base only through a PR</Text>
          <Text mono color="#AFA9EC">{'━'.repeat(Math.max(10, cols - (s.base ?? '').length - 12))} {s.base ?? ''}{s.baseHead ? ' ' + s.baseHead : ''}</Text>
          {s.worktrees.map((w, i) => {
            const col = w.conflict ? 'error' : w.behind ? 'warning' : 'success'
            const n = Math.min(w.ahead, 10)
            const commits = Array.from({ length: n }, () => '●').join('━') + (w.ahead > 10 ? '…' : '')
            const into = w.merged ? `merged into ${base}` : w.conflict ? `lane merges ${base} in, fixes, re-runs checks` : w.behind && w.pr ? `behind ${w.behind}: merges ${base} in first` : w.pr && w.checks === 'success' ? `merges into ${base} when checks pass` : 'waiting'
            const checks = !w.pr ? '' : w.conflict ? '✗ conflict' : w.checks === 'success' ? '✓ checks green' : w.checks === 'failure' ? '✗ checks red' : w.checks === 'pending' ? '◌ checks running' : 'no checks'
            return (
              <Box key={w.branch} flexDirection="row">
                <Text mono color="#AFA9EC">{i === s.worktrees.length - 1 ? ' ┗━' : ' ┣━'}</Text>
                <Text mono color={col}>{fit('━' + commits, 22, false)}</Text>
                <Text mono color={col}>{fit(w.branch, nameW, false)} </Text>
                <Text mono dimColor>+{w.ahead} −{w.behind}{w.dirty ? ' ✎' : ''}{w.lane ? ' ' + w.lane : ''}  </Text>
                <Text mono>▶ {w.pr ? 'PR #' + w.pr : w.ahead ? 'no PR yet' : 'no commits yet'}  </Text>
                <Text mono color={w.conflict || w.checks === 'failure' ? 'error' : w.checks === 'success' ? 'success' : undefined}>{checks}  </Text>
                <Text mono dimColor>→ {into}</Text>
              </Box>
            )
          })}
        </Box>
      )
    }

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

        {shown === 'grid' && s.phases.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text weight="medium">Product phases</Text>
            <Box flexDirection="row" gap={1}>{s.phases.map((p) => chip('pn' + p.name, p.tone, p.name, pw))}</Box>
            <Box flexDirection="row" gap={1}>{s.phases.map((p) => chip('pw' + p.name, p.tone, p.word, pw))}</Box>
            <Box flexDirection="row" gap={1}>{s.phases.map((p) => chip('ps' + p.name, p.tone, p.skill ?? '', pw))}</Box>
          </Box>
        ) : null}
        {shown === 'grid' ? (s.build.length ? grid(`Tickets in flight · ${s.busy} busy · each cell shows status and the agent on it`, BUILD_STEPS, s.build) : <Text dimColor>No lanes running.</Text>) : null}
        {shown === 'grid' && s.test.length ? grid('Test lanes', TEST_STEPS, s.test) : null}
        {shown === 'swim' ? swim() : null}
        {shown === 'tree' ? tree() : null}

        <Box flexDirection="row" gap={1} marginTop={1}>
          {chip('l1', 'done', 'Done', 6)}{chip('l2', 'running', 'Working now', 13)}{chip('l3', 'failed', 'Failed, recode', 16)}
          {chip('l4', 'blocked', 'Needs you', 11)}{chip('l5', 'waiting', 'Not reached', 13)}
          <Text dimColor>full dashboard: {s.url}</Text>
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text dimColor>{footer}</Text>
          <Button key="v-grid" label="Grid" onPress={() => pick('grid')} />
          {avail.includes('swim') ? <Button key="v-swim" label="Swimlanes" onPress={() => pick('swim')} /> : null}
          {avail.includes('tree') ? <Button key="v-tree" label="Worktrees" onPress={() => pick('tree')} /> : null}
          {vs?.pinned ? <Button key="v-rotate" label="Rotate" onPress={() => pick(null)} /> : null}
        </Box>
      </Box>
    )
  })
}

function offline(url: string, error: string, at: number): Summary {
  return { ok: false, error, at, url, done: 0, total: 0, busy: 0, decisions: [], phases: [], build: [], test: [], worktrees: [], segments: [] }
}
