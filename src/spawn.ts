import { spawn, type ChildProcess } from 'node:child_process'

// Runs a command the way a terminal would, on every platform. On Windows, npm, npx, yarn and most
// tools are .cmd or .bat files, which Node starts only through cmd.exe; there the command line is
// quoted for cmd.exe. Elsewhere the program runs directly, with no shell.
export function spawnCommand(command: string[], platform: NodeJS.Platform = process.platform): ChildProcess {
  if (platform !== 'win32') return spawn(command[0]!, command.slice(1), { stdio: 'inherit' })
  return spawn(winCommandLine(command), { stdio: 'inherit', shell: true })
}

// Quotes each argument for cmd.exe: arguments with spaces or cmd.exe metacharacters are wrapped in
// double quotes, with inner double quotes doubled.
export function winCommandLine(command: string[]): string {
  return command.map((a) => (a === '' || /[\s"&|<>^()%!,;=]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a)).join(' ')
}
