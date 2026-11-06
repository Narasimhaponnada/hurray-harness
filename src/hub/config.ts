import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_TEAMS, type TeamsConfig } from './teams.js'

export interface RepoConfig {
  path: string // a local clone; its worktrees are read from here
  github?: string // owner/name; detected from the origin remote when left out
  base: string // what lanes merge into, such as origin/main or origin/develop; HEAD means the main checkout's branch
  milestone?: string // a milestone title or number; default the earliest open one with open work
}

// Which tracker labels mean what. Matched case-insensitively. Board columns win when the tracker has them.
export interface LabelRules {
  decision: string[] // waits on a person: shown at the top of the dashboard
  blocked: string[]
  qa: string[]
  inProgress: string[]
  ready: string[]
}

export const DEFAULT_LABELS: LabelRules = {
  decision: ['needs-human', 'needs-decision', 'needs-review', 'question'],
  blocked: ['blocked', 'status:blocked'],
  qa: ['qa', 'needs-qa', 'status:qa'],
  inProgress: ['in-progress', 'status:in-progress', 'wip'],
  ready: ['ready', 'status:ready'],
}

export interface Config {
  host: string
  port: number
  dataDir: string
  refreshSeconds: number
  gitFetch: boolean
  keepDays: number
  repos: RepoConfig[]
  labels: LabelRules
  approvalBranches: string[] // a green PR into one of these waits for a person to merge it
  rotateSeconds: number // terminal and Claude Code views take turns this often; 0 shows one view
  teams: TeamsConfig // Microsoft Teams alerts for decisions, answered from your phone (docs/TEAMS.md)
  demo: boolean
}

export const DEFAULT_PORT = 7311

const home = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p)

export function defaultConfig(): Config {
  return {
    host: '127.0.0.1', // personal view: never listens beyond this machine
    port: DEFAULT_PORT,
    dataDir: join(homedir(), '.hurray-harness'),
    refreshSeconds: 60,
    gitFetch: false,
    keepDays: 14,
    repos: [],
    labels: { ...DEFAULT_LABELS },
    approvalBranches: [],
    rotateSeconds: 120,
    teams: { ...DEFAULT_TEAMS },
    demo: false,
  }
}

// Settings come from hh.config.json (in the current folder, or --config) and then the command line.
export function loadConfig(argv: string[]): Config {
  const cfg = defaultConfig()
  const flag = (name: string) => {
    const i = argv.indexOf('--' + name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const all = (name: string) => argv.flatMap((a, i) => (a === '--' + name && argv[i + 1] ? [argv[i + 1]!] : []))
  const file = flag('config') ?? (existsSync('hh.config.json') ? 'hh.config.json' : undefined)
  if (file) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config> & { repos?: Partial<RepoConfig>[]; labels?: Partial<LabelRules>; teams?: Partial<TeamsConfig> }
    Object.assign(cfg, { ...raw, repos: [], labels: { ...cfg.labels, ...raw.labels }, teams: { ...cfg.teams, ...raw.teams } })
    cfg.repos = (raw.repos ?? []).map((r) => ({ path: resolve(home(r.path ?? '.')), github: r.github, base: r.base ?? 'HEAD', milestone: r.milestone }))
  }
  const port = flag('port')
  if (port) cfg.port = Number(port)
  if (flag('host')) cfg.host = flag('host')!
  if (flag('data')) cfg.dataDir = resolve(home(flag('data')!))
  cfg.dataDir = resolve(home(cfg.dataDir))
  if (flag('refresh')) cfg.refreshSeconds = Math.max(15, Number(flag('refresh')))
  if (argv.includes('--fetch')) cfg.gitFetch = true
  if (argv.includes('--demo')) cfg.demo = true
  const rotate = flag('rotate') ?? process.env.HH_ROTATE
  if (rotate != null && rotate !== '' && Number.isFinite(Number(rotate))) cfg.rotateSeconds = Math.max(0, Number(rotate))
  const t = cfg.teams
  t.webhookUrl = flag('teams-webhook') ?? process.env.HH_TEAMS_WEBHOOK ?? t.webhookUrl
  t.publicUrl = flag('public-url') ?? process.env.HH_PUBLIC_URL ?? t.publicUrl
  if (flag('receiver-port')) t.receiverPort = Number(flag('receiver-port'))
  if (argv.includes('--tunnel')) t.tunnel = true
  const approvals = all('approval')
  if (approvals.length) cfg.approvalBranches = approvals
  const repos = all('repo')
  const githubs = all('github')
  const base = flag('base')
  const milestone = flag('milestone')
  for (const [i, p] of repos.entries()) {
    cfg.repos.push({ path: resolve(home(p)), github: githubs[i], base: base ?? 'HEAD', milestone })
  }
  if (!cfg.repos.length && !cfg.demo && existsSync('.git')) {
    cfg.repos.push({ path: resolve('.'), github: githubs[0], base: base ?? 'HEAD', milestone })
  }
  return cfg
}
