import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/hub/config.js'
import { Hub } from '../src/hub/hub.js'
import { createApp } from '../src/hub/server.js'
import { EventStore } from '../src/hub/store.js'

function setup() {
  const store = new EventStore(':memory:')
  const hub = new Hub({ ...defaultConfig(), demo: true }, store)
  return { app: createApp(hub), hub, store }
}

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('hub api', () => {
  it('accepts events, stores them and shows them in the state', async () => {
    const { app, store } = setup()
    const r = await post(app, '/api/events', [
      { kind: 'step.start', ticket: 42, lane: 'L1', step: 'code', agent: { role: 'developer' } },
      { kind: 'bogus' },
    ])
    expect(await r.json()).toMatchObject({ accepted: 1, errors: [{ index: 1 }] })
    expect(store.count()).toBe(1)
    const s = (await (await app.request('/api/state')).json()) as { live: { rows: { ticket: number }[] } }
    expect(s.live.rows[0]!.ticket).toBe(42)
  })

  it('refuses writes from another site', async () => {
    const { app } = setup()
    const r = await post(app, '/api/events', { kind: 'activity' }, { origin: 'https://evil.example' })
    expect(r.status).toBe(403)
  })

  it('ties a hook event to its ticket through the worktree path', async () => {
    const { app, hub } = setup()
    hub.setGit({ repoPath: '/r', base: 'origin/main', fetchedAt: 't', worktrees: [{ path: '/r/wt/42', branch: 'feat/42-x', head: 'a', ticket: 42, ahead: 1, behind: 0, dirty: false }] })
    await post(app, '/api/events', { kind: 'step.start', ticket: 42, lane: 'L1', step: 'code' })
    await post(app, '/api/hook/claude-code', { hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd: '/r/wt/42', tool_input: { file_path: '/r/wt/42/src/a.ts' } })
    const s = hub.snapshot().live
    expect(s.activity[0]).toMatchObject({ ticket: 42, detail: 'Edit /r/wt/42/src/a.ts' })
    expect(s.rows[0]!.steps.code!.detail).toBe('Edit /r/wt/42/src/a.ts')
  })
})

describe('hh step', () => {
  it('passes the exit code through and reports the step', async () => {
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'step', '--ticket', '9', '--step', 'check', '--port', '7999', '--', 'node', '-e', 'console.log("hi"); process.exit(3)'], { encoding: 'utf8' })
    expect(r.stdout).toContain('hi')
    expect(r.status).toBe(3)
  }, 30_000)

  it('quotes a Windows command line for cmd.exe', async () => {
    const { winCommandLine } = await import('../src/spawn.js')
    expect(winCommandLine(['npm', 'test'])).toBe('npm test')
    expect(winCommandLine(['node', '-e', 'console.log("a b")'])).toBe('node -e "console.log(""a b"")"')
    expect(winCommandLine(['git', 'commit', '-m', 'fix & ship'])).toBe('git commit -m "fix & ship"')
  })
})
