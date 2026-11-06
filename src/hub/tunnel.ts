import { spawn, type ChildProcess } from 'node:child_process'

// Starts a Cloudflare quick tunnel to the decision receiver and resolves with its public https URL.
// Needs cloudflared on PATH (brew install cloudflared, winget install Cloudflare.cloudflared, or the
// .deb from Cloudflare). The URL changes each time the tunnel starts, so cards sent before a restart
// stop working; a named tunnel or devtunnel with a fixed host avoids that (docs/TEAMS.md).
export function startTunnel(port: number, timeoutMs = 30_000): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { child.kill(); reject(new Error('cloudflared gave no URL within ' + timeoutMs / 1000 + ' s')) }, timeoutMs)
    const look = (buf: Buffer) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString())
      if (m) { clearTimeout(timer); resolve({ url: m[0], child }) }
    }
    child.stdout.on('data', look)
    child.stderr.on('data', look)
    child.on('error', (e) => { clearTimeout(timer); reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'cloudflared is not installed' : e.message)) })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('cloudflared exited with code ' + code)) })
  })
}
