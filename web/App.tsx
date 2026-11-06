import { useEffect, useState } from 'react'
import type { Snapshot } from '../src/shared/types.js'
import { Activity } from './views/Activity.js'
import { Agents } from './views/Agents.js'
import { Decisions } from './views/Decisions.js'
import { GitHubView } from './views/GitHubView.js'
import { LaneGrid } from './views/LaneGrid.js'
import { Phases } from './views/Phases.js'
import { Swimlanes } from './views/Swimlanes.js'
import { WorktreeGraph } from './views/WorktreeGraph.js'
import { ago } from './lib.js'

type Conn = 'connecting' | 'live' | 'offline'

function useSnapshot(): { snap?: Snapshot; conn: Conn } {
  const [snap, setSnap] = useState<Snapshot>()
  const [conn, setConn] = useState<Conn>('connecting')
  useEffect(() => {
    let es: EventSource | undefined
    let retry: number | undefined
    const open = () => {
      es = new EventSource('/api/stream')
      es.addEventListener('snapshot', (m) => {
        setSnap(JSON.parse((m as MessageEvent).data) as Snapshot)
        setConn('live')
      })
      es.onerror = () => {
        setConn('offline')
        es?.close()
        retry = window.setTimeout(open, 3000)
      }
    }
    open()
    return () => { es?.close(); if (retry) clearTimeout(retry) }
  }, [])
  return { snap, conn }
}

function useTick(ms: number) {
  const [, set] = useState(0)
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

export function App() {
  const { snap, conn } = useSnapshot()
  const [laneView, setLaneView] = useState<'grid' | 'swim'>('grid')
  useTick(5000)
  useDecisionNotifications((snap?.live.decisions ?? []).map((d) => d.id + '|' + d.title))

  if (!snap) {
    return (
      <div className="app">
        <Header conn={conn} />
        <p className="empty-note">{conn === 'offline' ? 'The hub is not running. Start it with: npx hh start' : 'Connecting to the hub…'}</p>
      </div>
    )
  }

  const run = snap.live.runs.find((r) => r.status === 'running') ?? snap.live.runs[0]
  const tracker = snap.trackers[0]
  const decisions = snap.live.decisions

  return (
    <div className="app">
      <Header conn={conn} repo={tracker?.repo ?? run?.repo} milestone={tracker?.milestone?.title ?? run?.milestone}
        run={run ? `${run.stage ?? ''} · ${run.status === 'running' ? 'running' : 'ended'} · started ${ago(run.startedAt)} ago` : undefined} />

      <Decisions items={decisions} />

      <section className="section">
        <header><h2>Product phases</h2><span className="hint">the skill running each phase; amber means it waits on you</span></header>
        <Phases phases={snap.live.phases} decisions={decisions} />
      </section>

      <GitHubView trackers={snap.trackers} rows={snap.live.rows} />

      <section className="section">
        <header>
          <h2>Lanes</h2>
          <span className="hint">{laneView === 'grid' ? 'each cell: status and the agent on it · click a cell for detail' : 'each bar is one step, colored by agent'}</span>
          <div className="right">
            <button aria-pressed={laneView === 'grid'} onClick={() => setLaneView('grid')}>Grid</button>
            <button aria-pressed={laneView === 'swim'} onClick={() => setLaneView('swim')}>Swimlanes</button>
          </div>
        </header>
        {laneView === 'grid' ? <LaneGrid rows={snap.live.rows} /> : <Swimlanes segments={snap.live.segments} />}
      </section>

      <section className="section">
        <header><h2>Worktrees to merge</h2><span className="hint">each lane works in its own worktree; work reaches the base branch only through a PR</span></header>
        <WorktreeGraph git={snap.git} changes={tracker?.changes ?? []} rows={snap.live.rows} />
      </section>

      <div className="grid2">
        <section className="section">
          <header><h2>Agents</h2><span className="hint">by role</span></header>
          <Agents agents={snap.live.agents} />
        </section>
        <section className="section">
          <header><h2>Activity</h2><span className="hint">from Claude Code and Cursor hooks</span></header>
          <Activity items={snap.live.activity} />
        </section>
      </div>
    </div>
  )
}

function Header(p: { conn: Conn; repo?: string; milestone?: string; run?: string }) {
  const color = p.conn === 'live' ? 'var(--ok-fill)' : p.conn === 'offline' ? 'var(--bad-fill)' : 'var(--warn-fill)'
  return (
    <div className="top">
      <div className="brand"><h1>hurray-harness</h1><span>Track every build. Lose fewer hairs.</span></div>
      <div className="meta">
        {p.repo && <span className="mono">{p.repo}</span>}
        {p.milestone && <span>Milestone {p.milestone}</span>}
        {p.run && <span>Run: {p.run}</span>}
        <span><i className="dot" style={{ background: color }} />{p.conn}</span>
      </div>
    </div>
  )
}

// A desktop notification for each new item that waits on you, once the person has allowed them.
function useDecisionNotifications(keys: string[]) {
  const sig = keys.join('\n')
  useEffect(() => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    let seen: string[] = []
    try { seen = JSON.parse(localStorage.getItem('hh-seen-decisions') ?? '[]') as string[] } catch { /* no storage */ }
    const fresh = keys.filter((k) => !seen.includes(k))
    for (const k of fresh.slice(0, 3)) new Notification('Needs your decision', { body: k.split('|')[1] ?? k, tag: k })
    try { localStorage.setItem('hh-seen-decisions', JSON.stringify(keys)) } catch { /* no storage */ }
  }, [sig])
}
