#!/usr/bin/env node
// Node's built-in SQLite prints an "experimental" warning on every start; it is expected, so hide just that one.
const emit = process.emitWarning
process.emitWarning = (warning, ...rest) => {
  if (String(warning?.message ?? warning).includes('SQLite')) return
  return emit.call(process, warning, ...rest)
}
await import('../dist/cli.js')
