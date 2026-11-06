// What the plugin keeps from the hub's snapshot: only what the status line, band and pane draw.

export type Cell = 'done' | 'running' | 'failed' | 'blocked' | 'skipped' | 'waiting'

export type LaneRow = {
  key: string
  lane?: string
  ticket: number
  title?: string
  kind: 'build' | 'test'
  cells: Cell[]
  words: [string, string][] // per step: status word on top, agent below
  step?: string // the running or last step's label
  agent?: string
  model?: string
  skill?: string
  doing?: string
  attempt: number
}

export type PhaseRow = { name: string; tone: Cell; word: string; skill?: string }

export type WorktreeRow = { branch: string; ahead: number; behind: number; pr?: number; checks?: string; conflict: boolean }

export type DecisionRow = { id: string; title: string; why?: string; url?: string }

export type Summary = {
  ok: boolean
  error?: string
  at: number
  url: string
  repo?: string
  milestone?: string
  stage?: string
  done: number
  total: number
  busy: number
  decisions: DecisionRow[]
  phases: PhaseRow[]
  build: LaneRow[]
  test: LaneRow[]
  worktrees: WorktreeRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'hurray-harness': { summary: Shaped<Summary | null>; bandHidden: boolean }
  }
}
