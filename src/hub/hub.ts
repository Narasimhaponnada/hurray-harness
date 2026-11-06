import { LiveBuilder } from '../shared/reduce.js'
import type { Decision, GitSnapshot, HHEvent, Snapshot, TrackerSnapshot } from '../shared/types.js'
import type { Config } from './config.js'
import { trackerDecisions } from './decisions.js'
import { gitRemoteRepo, gitSnapshot, worktreeFor } from './git.js'
import { EventStore } from './store.js'
import type { TeamsNotifier } from './teams.js'
import type { TrackerAdapter } from './trackers/index.js'
import { GitHubAdapter } from './trackers/github.js'

type Listener = (s: Snapshot) => void

export class Hub {
  private builder = new LiveBuilder()
  private trackers: TrackerAdapter[] = []
  private trackerSnaps = new Map<string, TrackerSnapshot>()
  private gitSnaps = new Map<string, GitSnapshot>()
  private repoOfPath = new Map<string, string>()
  private listeners = new Set<Listener>()
  private timer?: NodeJS.Timeout
  private pending?: NodeJS.Timeout
  private polling = false
  notifier?: TeamsNotifier

  constructor(readonly cfg: Config, readonly store: EventStore) {}

  async init(): Promise<void> {
    const since = new Date(Date.now() - this.cfg.keepDays * 86_400_000).toISOString()
    this.store.prune(since)
    for (const e of this.store.since(since)) this.builder.apply(e)
    if (this.cfg.demo) return
    for (const r of this.cfg.repos) {
      const gh = r.github ?? (await gitRemoteRepo(r.path))
      if (gh) {
        r.github = gh
        this.repoOfPath.set(r.path, gh)
        this.trackers.push(new GitHubAdapter(gh, r.milestone, this.cfg.labels))
      }
    }
  }

  start(): void {
    if (this.cfg.demo) return
    void this.poll()
    this.timer = setInterval(() => void this.poll(), this.cfg.refreshSeconds * 1000)
    // Worktrees change faster than the tracker; read them more often, it is local and cheap.
    setInterval(() => void this.pollGit(), 10_000).unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      await this.pollGit()
      const snaps = await Promise.all(this.trackers.map((t) => t.snapshot()))
      for (const s of snaps) this.trackerSnaps.set(s.provider + ':' + s.repo, s)
      this.changed()
    } finally {
      this.polling = false
    }
  }

  async pollGit(): Promise<void> {
    const snaps = await Promise.all(this.cfg.repos.map((r) => gitSnapshot(r.path, r.base, this.cfg.gitFetch)))
    let moved = false
    for (const s of snaps) {
      const prev = this.gitSnaps.get(s.repoPath)
      if (!prev || JSON.stringify(prev.worktrees) !== JSON.stringify(s.worktrees)) moved = true
      this.gitSnaps.set(s.repoPath, s)
    }
    if (moved) this.changed()
  }

  // Demo only: forget the live state and the stored events.
  resetLive(): void {
    this.store.prune(new Date(Date.now() + 60_000).toISOString())
    this.builder = new LiveBuilder()
    this.changed()
  }

  setTracker(s: TrackerSnapshot): void {
    this.trackerSnaps.set(s.provider + ':' + s.repo, s)
    this.changed()
  }

  setGit(s: GitSnapshot): void {
    this.gitSnaps.set(s.repoPath, s)
    this.changed()
  }

  // Ties an event to a ticket and repo through the worktree it came from, when the sender did not say.
  enrich(e: HHEvent): HHEvent {
    if (e.ticket != null && e.repo) return e
    const path = e.cwd ?? e.files?.[0]
    if (!path) return e
    const hit = worktreeFor(path, [...this.gitSnaps.values()])
    if (!hit) return e
    return {
      ...e,
      ticket: e.ticket ?? hit.wt.ticket,
      branch: e.branch ?? hit.wt.branch,
      repo: e.repo ?? this.repoOfPath.get(hit.snap.repoPath),
    }
  }

  ingest(raw: HHEvent): HHEvent {
    const e = this.enrich(raw)
    this.store.append(e)
    this.builder.apply(e)
    this.changed()
    return e
  }

  // An open or answered decision sent by a harness.
  decision(id: string): Decision | undefined {
    return this.builder.decision(id)
  }

  // Records a person's choice. With options, the choice must be one of them (any letter case).
  answer(id: string, choice: string, via: string): { ok: true; decision: Decision } | { ok: false; error: string } {
    const d = this.builder.decision(id)
    if (!d) return { ok: false, error: 'no open decision with that id' }
    if (d.answer) return { ok: false, error: 'already decided: ' + d.answer.choice }
    const picked = d.options?.length ? d.options.find((o) => o.toLowerCase() === choice.trim().toLowerCase()) : choice.trim().slice(0, 80)
    if (!picked) return { ok: false, error: 'choose one of: ' + d.options!.join(', ') }
    this.ingest({ v: 1, ts: new Date().toISOString(), kind: 'decision.answer', source: via, repo: d.repo, ticket: d.ticket, decision: { id, title: d.title, choice: picked } })
    return { ok: true, decision: this.builder.decision(id)! }
  }

  snapshot(): Snapshot {
    const live = this.builder.snapshot()
    const trackers = [...this.trackerSnaps.values()]
    const fromTracker = trackerDecisions(trackers, this.cfg.labels, this.cfg.approvalBranches)
    const seen = new Set(live.decisions.map((d) => d.id))
    const decisions: Decision[] = [...live.decisions, ...fromTracker.filter((d) => !seen.has(d.id))]
    return { live: { ...live, decisions }, trackers, git: [...this.gitSnaps.values()] }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // Many events can arrive at once (a lane finishing); send one update for the burst.
  private changed(): void {
    if (this.pending) return
    this.pending = setTimeout(() => {
      this.pending = undefined
      if (!this.listeners.size && !this.notifier?.enabled) return
      const s = this.snapshot()
      if (this.notifier?.enabled) void this.notifier.sync(s.live.decisions, s.live.answered)
      for (const fn of this.listeners) fn(s)
    }, 200)
  }
}
