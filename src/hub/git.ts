import { resolve, sep } from 'node:path'
import type { GitSnapshot, Worktree } from '../shared/types.js'
import { run } from './exec.js'

// Branch names the harness uses: feat|fix|chore|docs|test/<issue>-<slug>. Other tools often use the same shape.
export const TICKET_BRANCH = /^(?:refs\/heads\/)?(?:[a-z]+\/)?(\d+)[-_/]/i

export function ticketFromBranch(branch: string): number | undefined {
  const m = TICKET_BRANCH.exec(branch)
  return m ? Number(m[1]) : undefined
}

export function parseWorktreeList(out: string): { path: string; head: string; branch: string }[] {
  const list: { path: string; head: string; branch: string }[] = []
  let cur: { path: string; head: string; branch: string } | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) list.push(cur)
      cur = { path: line.slice(9), head: '', branch: '' }
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5)
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (cur && line === 'detached') cur.branch = '(detached)'
  }
  if (cur) list.push(cur)
  return list
}

export async function gitRemoteRepo(path: string): Promise<string | undefined> {
  const r = await run('git', ['-C', path, 'remote', 'get-url', 'origin'], { timeoutMs: 5000 })
  if (r.code) return undefined
  const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\s*$/.exec(r.stdout.trim())
  return m ? m[1] + '/' + m[2] : undefined
}

// Reads the worktrees of one repo and how far each is ahead of and behind the base branch. Read-only:
// it fetches only when asked, and never checks out, merges or deletes anything.
// "HEAD" means: the branch checked out in the main folder, compared against its origin copy when there is one.
export async function resolveBase(root: string, base: string): Promise<string> {
  if (base !== 'HEAD') return base
  const br = (await run('git', ['-C', root, 'symbolic-ref', '--short', '-q', 'HEAD'], { timeoutMs: 5000 })).stdout.trim()
  if (!br) return 'HEAD'
  const remote = await run('git', ['-C', root, 'rev-parse', '--verify', '-q', 'origin/' + br], { timeoutMs: 5000 })
  return remote.code ? br : 'origin/' + br
}

export async function gitSnapshot(repoPath: string, baseWanted: string, fetch = false): Promise<GitSnapshot> {
  const fetchedAt = new Date().toISOString()
  const root = resolve(repoPath)
  if (fetch) await run('git', ['-C', root, 'fetch', '--quiet', 'origin'], { timeoutMs: 60_000 })
  const wl = await run('git', ['-C', root, 'worktree', 'list', '--porcelain'], { timeoutMs: 10_000 })
  if (wl.code) return { repoPath: root, base: baseWanted, worktrees: [], fetchedAt, error: wl.stderr.trim() || 'not a git repository' }
  const base = await resolveBase(root, baseWanted)
  const baseHead = (await run('git', ['-C', root, 'rev-parse', '--short', base], { timeoutMs: 5000 })).stdout.trim() || undefined
  const worktrees: Worktree[] = []
  for (const w of parseWorktreeList(wl.stdout)) {
    if (!w.branch || w.branch === '(detached)') continue
    const [counts, last, status] = await Promise.all([
      run('git', ['-C', w.path, 'rev-list', '--left-right', '--count', base + '...HEAD'], { timeoutMs: 10_000 }),
      run('git', ['-C', w.path, 'log', '-1', '--format=%cI'], { timeoutMs: 5000 }),
      run('git', ['-C', w.path, 'status', '--porcelain', '--untracked-files=no'], { timeoutMs: 10_000 }),
    ])
    const [behind, ahead] = counts.code ? [0, 0] : counts.stdout.trim().split(/\s+/).map(Number)
    worktrees.push({
      path: w.path, branch: w.branch, head: w.head.slice(0, 7), ticket: ticketFromBranch(w.branch),
      ahead: ahead ?? 0, behind: behind ?? 0, lastCommitAt: last.stdout.trim() || undefined, dirty: !!status.stdout.trim(),
    })
  }
  return { repoPath: root, base, baseHead, worktrees, fetchedAt }
}

// Which worktree a file or working folder sits in, so a tool hook's event can be tied to its ticket.
export function worktreeFor(path: string, snaps: GitSnapshot[]): { wt: Worktree; snap: GitSnapshot } | undefined {
  const p = resolve(path)
  let best: { wt: Worktree; snap: GitSnapshot } | undefined
  for (const snap of snaps) {
    for (const wt of snap.worktrees) {
      const root = resolve(wt.path)
      if ((p === root || p.startsWith(root + sep)) && (!best || root.length > resolve(best.wt.path).length)) best = { wt, snap }
    }
  }
  return best
}
