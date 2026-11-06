import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Cell, LaneRow, Summary } from '../types'
import { BUILD_STEPS, GLYPH, STEP_LABEL, TEST_STEPS, statusLine, summarize } from './summarize.ts'

// hurray-harness for Claude Code: reads the local hub (hh start) every few seconds and shows
//   - a status line: stage, busy lanes, what needs you, milestone progress
//   - a band above the prompt whenever something needs you
//   - a lanes pane beside the chat (/lanes): every lane's steps, agent, what it is doing, worktrees
// Read-only: it only fetches the hub's /api/state.

const PANE = 'hh-lanes'
const POLL_MS = 4000
const summary = atom({ plugin: 'hurray-harness', key: 'summary' } as const, null, { shape: 'summary-1' })
const bandHidden = atom({ plugin: 'hurray-harness', key: 'bandHidden' } as const, false)

const CELL_COLOR: Record<Cell, string> = { done: 'success', running: 'suggestion', failed: 'error', blocked: 'warning', skipped: 'subtle', waiting: 'subtle' }

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
    const row = (r: LaneRow) => (
      <Box key={r.key} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          <Text mono weight="medium">{(r.lane ?? '').padEnd(3)} #{r.ticket}</Text>
          <Text mono>{r.cells.map((c, i) => <Text key={String(i)} color={CELL_COLOR[c]}>{GLYPH[c]}</Text>)}</Text>
          <Text>{r.step ?? ''}{r.attempt > 1 ? ` (recode ${r.attempt})` : ''}</Text>
          <Text dimColor>{[r.agent, r.model, r.skill].filter(Boolean).join(' · ')}</Text>
        </Box>
        <Text dimColor>{'      '}{r.title ?? ''}{r.doing ? ' · ' + r.doing : ''}</Text>
      </Box>
    )
    const legend = (steps: string[]) => steps.map((x) => STEP_LABEL[x] ?? x).join(' › ')
    return (
      <Box flexDirection="column">
        <Text weight="medium">{[s.repo, s.milestone ? 'milestone ' + s.milestone : '', s.stage].filter(Boolean).join(' · ')}</Text>
        {s.total ? <Text mono>{bar(s.done, s.total)} {s.done}/{s.total} done</Text> : null}

        {s.decisions.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color="warning" weight="medium">Needs you ({s.decisions.length})</Text>
            {s.decisions.map((d) => <Text key={d.id} color="warning">  {d.title}{d.why ? ' · ' + d.why : ''}</Text>)}
          </Box>
        ) : null}

        <Box flexDirection="column" marginTop={1}>
          <Text weight="medium">Build lanes · {s.busy} busy</Text>
          <Text dimColor>      {legend(BUILD_STEPS)}</Text>
          {s.build.length ? s.build.map(row) : <Text dimColor>No lanes running.</Text>}
        </Box>

        {s.test.length ? (
          <Box flexDirection="column">
            <Text weight="medium">Test lanes</Text>
            <Text dimColor>      {legend(TEST_STEPS)}</Text>
            {s.test.map(row)}
          </Box>
        ) : null}

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

        <Text dimColor>✓ done ● working ✗ failed ! needs you · not reached · full dashboard: {s.url}</Text>
      </Box>
    )
  })
}

function offline(url: string, error: string, at: number): Summary {
  return { ok: false, error, at, url, done: 0, total: 0, busy: 0, decisions: [], build: [], test: [], worktrees: [] }
}
