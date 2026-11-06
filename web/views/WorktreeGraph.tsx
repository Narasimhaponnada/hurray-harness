import type { ChangeRequest, GitSnapshot, TicketRow, Worktree } from '../../src/shared/types.js'
import { ago } from '../lib.js'

// One row per worktree: its branch off the base, how far ahead and behind it is, then its PR, gate and merge.
export function WorktreeGraph({ git, changes, rows }: { git: GitSnapshot[]; changes: ChangeRequest[]; rows: TicketRow[] }) {
  const repos = git.filter((g) => g.worktrees.length || g.error)
  if (!repos.length) return <p className="empty-note">No local repo watched yet. Start the hub inside your repo or pass --repo PATH.</p>
  return (
    <div>
      {repos.map((g) => <Repo key={g.repoPath} g={g} changes={changes} rows={rows} />)}
      <div className="legend">
        <span>Lanes never merge into each other locally. A lane pushes its branch, opens a PR, and the tracker merges it when its checks pass.</span>
        <span>Behind the base means the lane must merge the base into its own worktree before its PR can merge.</span>
      </div>
    </div>
  )
}

function Repo({ g, changes, rows }: { g: GitSnapshot; changes: ChangeRequest[]; rows: TicketRow[] }) {
  if (g.error) return <p className="err">{g.repoPath}: {g.error}</p>
  const base = g.base.replace(/^origin\//, '')
  const lanes = g.worktrees.filter((w) => w.branch !== base && !w.branch.endsWith('/' + base))
  const W = 980, LEFT = 24, ROW = 46, TOP = 58
  const H = TOP + Math.max(1, lanes.length) * ROW + 16
  const colBranch = 70, colPush = 560, colGate = 680, colMerge = 820

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 720 }} role="img" aria-label={`Worktrees of ${g.repoPath} and their path to ${g.base}`}>
        <text x={LEFT} y={14} className="t3">{g.repoPath}</text>
        <text x={colPush} y={30} className="t2">push and PR</text>
        <text x={colGate} y={30} className="t2">checks</text>
        <text x={colMerge} y={30} className="t2">into {base}</text>
        <line x1={LEFT} x2={W - 10} y1={TOP - 12} y2={TOP - 12} stroke="var(--qa-fill)" strokeWidth={3} />
        <text x={LEFT} y={TOP - 18} style={{ fontSize: 11, fontWeight: 600 }}>{g.base}{g.baseHead ? ' · ' + g.baseHead : ''}</text>
        {lanes.map((w, i) => (
          <LaneRow key={w.path} w={w} y={TOP + i * ROW + 14} pr={prFor(w, changes)} row={rows.find((r) => r.ticket === w.ticket)}
            cols={{ LEFT, colBranch, colPush, colGate, colMerge, TOP }} />
        ))}
        {!lanes.length && <text x={LEFT} y={TOP + 24} className="t3">No lane worktrees right now: every branch has merged or none has started.</text>}
      </svg>
    </div>
  )
}

function prFor(w: Worktree, changes: ChangeRequest[]): ChangeRequest | undefined {
  return changes.find((c) => c.head === w.branch && c.state === 'open') ?? changes.find((c) => c.head === w.branch)
}

interface Cols { LEFT: number; colBranch: number; colPush: number; colGate: number; colMerge: number; TOP: number }

function LaneRow({ w, y, pr, row, cols }: { w: Worktree; y: number; pr?: ChangeRequest; row?: TicketRow; cols: Cols }) {
  const { LEFT, colBranch, colPush, colGate, colMerge, TOP } = cols
  const conflict = pr?.mergeable === 'conflicting'
  const color = conflict ? 'var(--bad-fill)' : w.behind > 0 ? 'var(--warn-fill)' : 'var(--ok-fill)'
  const commits = Math.min(w.ahead, 12)
  const dot = (cx: number, fill: string, r = 4) => <circle cx={cx} cy={y} r={r} fill={fill} />
  const gate = pr ? (pr.checks === 'success' ? ['green', 'var(--ok-fill)'] : pr.checks === 'failure' ? ['red', 'var(--bad-fill)'] : pr.checks === 'pending' ? ['running', 'var(--run-fill)'] : ['none', 'var(--text-3)']) : null
  const merged = pr?.state === 'merged'
  const label = w.branch
  return (
    <g>
      <title>{`${w.path}\n${w.ahead} ahead, ${w.behind} behind${w.dirty ? ', uncommitted changes' : ''}${w.lastCommitAt ? '\nlast commit ' + ago(w.lastCommitAt) + ' ago' : ''}`}</title>
      <path d={`M ${LEFT + 20} ${TOP - 12} C ${LEFT + 30} ${y}, ${LEFT + 40} ${y}, ${colBranch} ${y}`} fill="none" stroke={color} strokeWidth={2} />
      <line x1={colBranch} x2={colPush - 14} y1={y} y2={y} stroke={color} strokeWidth={2} />
      {Array.from({ length: commits }, (_, i) => dot(colBranch + 20 + i * ((colPush - colBranch - 60) / Math.max(commits, 1)), color))}
      <text x={colBranch} y={y - 8} style={{ fontSize: 11, fontWeight: 600 }}>{label}</text>
      <text x={colBranch + 260} y={y - 8} className="t3">
        {w.ahead} ahead · {w.behind} behind{w.dirty ? ' · uncommitted' : ''}{row?.lane ? ' · ' + row.lane : ''}
      </text>
      {w.behind > 0 && <text x={colBranch} y={y + 16} className="t3" style={{ fill: conflict ? 'var(--bad)' : 'var(--warn)' }}>
        {conflict ? 'conflict: lane merges the base into its worktree, fixes, and re-runs its checks' : 'behind the base: merges it in before the PR can merge'}
      </text>}
      <rect x={colPush - 10} y={y - 11} width={100} height={22} rx={4} fill={pr ? 'var(--sunk)' : 'none'} stroke={pr ? 'none' : 'var(--line-strong)'} strokeDasharray={pr ? '' : '3 3'} />
      <text x={colPush} y={y + 4} style={{ fontSize: 11 }}>{pr ? 'PR #' + pr.number : w.ahead ? 'not pushed or no PR' : 'no commits yet'}</text>
      {gate && (
        <>
          <rect x={colGate - 10} y={y - 11} width={110} height={22} rx={4} fill={conflict ? 'var(--bad-bg)' : 'var(--sunk)'} />
          <circle cx={colGate} cy={y} r={5} fill={gate[1]} />
          <text x={colGate + 10} y={y + 4} style={{ fontSize: 11 }}>{conflict ? 'conflict' : 'checks ' + gate[0]}</text>
        </>
      )}
      {merged ? (
        <><path d={`M ${colMerge - 30} ${y} C ${colMerge} ${y}, ${colMerge + 20} ${TOP - 12}, ${colMerge + 40} ${TOP - 12}`} fill="none" stroke="var(--qa-fill)" strokeWidth={2} />
          <text x={colMerge + 10} y={y + 4} style={{ fontSize: 11, fill: 'var(--ok)' }}>merged</text></>
      ) : pr && gate?.[0] === 'green' && !conflict ? (
        <text x={colMerge} y={y + 4} style={{ fontSize: 11, fill: 'var(--run)' }}>merges when checks pass</text>
      ) : (
        <text x={colMerge} y={y + 4} className="t3">waiting</text>
      )}
    </g>
  )
}
