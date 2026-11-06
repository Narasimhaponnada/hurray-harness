// The event contract (v1). Any harness, hook or adapter that can send JSON can report into the hub.
// Full description: docs/EVENTS.md.

export type Status = 'waiting' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped'

export type EventKind =
  | 'run.start' // a harness run begins (one milestone, one repo)
  | 'run.stage' // the run moves to a new stage (Preflight, Lead, Build, Promote, Test, Release)
  | 'run.end'
  | 'phase' // an SDLC phase changes status (Discovery ... Launch)
  | 'step.start' // an agent starts one step of one ticket
  | 'step.end'
  | 'decision.open' // something waits on a person
  | 'decision.close'
  | 'activity' // a raw agent action from a tool hook (edit, shell command, MCP call)

export interface AgentRef {
  role: string // developer, tester, architect, or the tool's own agent name
  model?: string
  name?: string
}

export interface DecisionRef {
  id: string
  title: string
  why?: string
  recommendation?: string
  url?: string
}

export interface HHEvent {
  v: 1
  ts: string // ISO time
  kind: EventKind
  source: string // your harness's name, claude-code, cursor, cli, manual
  user?: string
  machine?: string
  repo?: string // owner/name
  run?: string
  milestone?: string
  mode?: string
  stage?: string
  phase?: string
  lane?: string // L1, L2, cycle-2 ...
  ticket?: number
  title?: string
  epic?: number
  step?: string // plan, code, tests, check, pr, review, merge, close; qa-plan, run, verify ...
  agent?: AgentRef
  skill?: string
  status?: Status
  attempt?: number
  detail?: string // what the agent is doing, in one line
  files?: string[]
  tokens?: { used?: number; budget?: number }
  pr?: number
  branch?: string
  session?: string // the tool's session or conversation id
  cwd?: string
  tool?: string // the tool that produced an activity event: Edit, Bash, MCP ...
  decision?: DecisionRef
}

// ---------- derived state, what the dashboard draws ----------

export interface StepState {
  step: string
  status: Status
  agent?: AgentRef
  skill?: string
  detail?: string
  files: string[]
  attempt: number
  tokens?: { used?: number; budget?: number }
  startedAt?: string
  endedAt?: string
}

export type RowKind = 'dev' | 'qa' | 'other'

export interface TicketRow {
  key: string
  run?: string
  repo?: string
  ticket: number
  title?: string
  epic?: number
  lane?: string
  kind: RowKind
  steps: Record<string, StepState>
  current?: string
  pr?: number
  branch?: string
  updatedAt: string
  finished: boolean
}

export interface Segment {
  lane: string
  ticket?: number
  step: string
  status: Status
  role?: string
  skill?: string
  start: string
  end?: string
}

export interface RunState {
  run: string
  repo?: string
  milestone?: string
  mode?: string
  stage?: string
  status: 'running' | 'ended'
  startedAt: string
  endedAt?: string
  user?: string
}

export interface Decision extends DecisionRef {
  openedAt: string
  source: string
  repo?: string
  ticket?: number
}

export interface PhaseState {
  name: string
  status: Status
  skill?: string
  agent?: string
  detail?: string
}

export interface ActivityItem {
  ts: string
  source: string
  session?: string
  ticket?: number
  tool?: string
  detail: string
}

export interface AgentState {
  key: string
  role: string
  model?: string
  status: 'busy' | 'idle'
  ticket?: number
  step?: string
  skill?: string
  since: string
}

export interface LiveState {
  runs: RunState[]
  rows: TicketRow[]
  segments: Segment[]
  decisions: Decision[]
  phases: PhaseState[]
  agents: AgentState[]
  activity: ActivityItem[]
  updatedAt: string
}

// ---------- tracker and git snapshots (read-only, polled) ----------

export type BoardStatus = 'Backlog' | 'Ready' | 'In Progress' | 'In Review' | 'QA Validation' | 'Done' | 'Blocked' | string

export interface WorkItem {
  number: number
  title: string
  type: string // Feature, Task, Bug, Epic ...
  state: 'open' | 'closed'
  status: BoardStatus
  labels: string[]
  epic?: number
  url: string
  prs: { number: number; state: string; url: string }[]
}

export interface Epic {
  number: number
  title: string
  url: string
  total: number
  done: number
  active: number
  blocked: number
}

export interface ChangeRequest {
  number: number
  title: string
  head: string
  base: string
  state: 'open' | 'merged' | 'closed'
  draft: boolean
  mergeable: 'mergeable' | 'conflicting' | 'unknown'
  checks: 'success' | 'failure' | 'pending' | 'none'
  url: string
  ticket?: number
}

export interface TrackerSnapshot {
  provider: 'github' | 'gitlab' | 'jira'
  repo: string
  milestone?: { title: string; dueOn?: string; url?: string; open: number; closed: number }
  board: Record<string, number>
  items: WorkItem[]
  epics: Epic[]
  changes: ChangeRequest[]
  fetchedAt: string
  error?: string
}

export interface Worktree {
  path: string
  branch: string
  head: string
  ticket?: number
  ahead: number
  behind: number
  lastCommitAt?: string
  dirty: boolean
}

export interface GitSnapshot {
  repoPath: string
  base: string
  baseHead?: string
  worktrees: Worktree[]
  fetchedAt: string
  error?: string
}

export interface Snapshot {
  live: LiveState
  trackers: TrackerSnapshot[]
  git: GitSnapshot[]
}
