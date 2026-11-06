import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Cell, LaneRow, Summary } from '../types'
import { BUILD_STEPS, STEP_LABEL, TEST_STEPS, statusLine, summarize } from './summarize.ts'

// hurray-harness for Claude Code: reads the local hub (hh start) every few seconds and shows
//   - a status line: stage, busy lanes, what needs you, milestone progress
//   - a band above the prompt whenever something needs you
//   - a lanes pane beside the chat (/lanes): every lane's steps, agent, what it is doing, worktrees
// Read-only: it only fetches the hub's /api/state.

const PANE = 'hh-lanes'
const POLL_MS = 4000
const summary = atom({ plugin: 'hurray-harness', key: 'summary' } as const, null, { shape: 'summary-1' })
const bandHidden = atom({ plugin: 'hurray-harness', key: 'bandHidden' } as const, false)

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
    const { Box, Text } = $.ui.resolve(e)
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

        {s.phases.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text weight="medium">Product phases</Text>
            <Box flexDirection="row" gap={1}>{s.phases.map((p) => chip('pn' + p.name, p.tone, p.name, pw))}</Box>
            <Box flexDirection="row" gap={1}>{s.phases.map((p) => chip('pw' + p.name, p.tone, p.word, pw))}</Box>
            <Box flexDirection="row" gap={1}>{s.phases.map((p) => chip('ps' + p.name, p.tone, p.skill ?? '', pw))}</Box>
          </Box>
        ) : null}

        {s.build.length ? grid(`Tickets in flight · ${s.busy} busy · each cell shows status and the agent on it`, BUILD_STEPS, s.build) : <Text dimColor>No lanes running.</Text>}
        {s.test.length ? grid('Test lanes', TEST_STEPS, s.test) : null}

        {s.worktrees.length ? (
          <Box flexDirection="column">
            <Text weight="medium">Worktrees</Text>
            {s.worktrees.map((w) => (
              <Text key={w.branch} mono color={w.conflict ? 'error' : w.behind ? 'warning' : undefined}>
                {'  '}{w.branch} +{w.ahead} −{w.behind}{w.pr ? ` · PR #${w.pr} ${w.conflict ? 'conflict' : w.checks ?? ''}` : ' · no PR'}
              </Text>
            ))}
          </Box>
        ) : null}

        <Box flexDirection="row" gap={1} marginTop={1}>
          {chip('l1', 'done', 'Done', 6)}{chip('l2', 'running', 'Working now', 13)}{chip('l3', 'failed', 'Failed, recode', 16)}
          {chip('l4', 'blocked', 'Needs you', 11)}{chip('l5', 'waiting', 'Not reached', 13)}
          <Text dimColor>full dashboard: {s.url}</Text>
        </Box>
      </Box>
    )
  })
}

function offline(url: string, error: string, at: number): Summary {
  return { ok: false, error, at, url, done: 0, total: 0, busy: 0, decisions: [], phases: [], build: [], test: [], worktrees: [] }
}
