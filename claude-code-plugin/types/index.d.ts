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
  since?: number // when the running step started
  used?: number
  budget?: number
}

export type PhaseRow = { name: string; tone: Cell; word: string; skill?: string }

export type WorktreeRow = { branch: string; ahead: number; behind: number; pr?: number; checks?: string; conflict: boolean; merged?: boolean; dirty?: boolean; lane?: string; lastCommitAt?: number }

export type SegmentRow = { lane: string; role?: string; step: string; status: Cell; start: number; end?: number; ticket?: number }

export type AgentRow = { lane?: string; role: string; model?: string; skill?: string; ticket?: number; step?: string; attempt: number; since: number; doing?: string; used?: number; budget?: number }

export type GhStage = 'blocked' | 'working' | 'review' | 'qa'
export type GhRow = { number: number; title: string; bug: boolean; stage: GhStage; pr?: number; checks?: string; conflict?: boolean; who?: string }
// The tracker's work in flight: bugs and issues in progress, in review, in QA or blocked.
export type GitHubNow = { summary: string; rows: GhRow[]; more: number; bugsNotStarted: string[] }

export type PaneView = 'now' | 'flow'
export type ViewState = { pinned: PaneView | null; start: number }

export type DecisionRow = { id: string; title: string; why?: string; url?: string }

export type Summary = {
  ok: boolean
  error?: string
  starting?: boolean // the plugin is starting the hub
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
  base?: string
  baseHead?: string
  segments: SegmentRow[]
  agents: AgentRow[] // running now
  idle: { role: string; lanes: string[] }[]
  github?: GitHubNow
}

declare module 'claude-code' {
  interface PluginState {
    'hurray-harness': { summary: Shaped<Summary | null>; bandHidden: boolean; view: Shaped<ViewState | null> }
  }
}
