import { execFile } from 'node:child_process'

export interface RunResult { code: number; stdout: string; stderr: string }

// Runs a command without a shell, so no argument is ever interpreted by one.
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : '')) })
    })
    if (opts.input != null) {
      child.stdin?.end(opts.input)
    }
  })
}
