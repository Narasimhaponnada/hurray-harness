import type { HHEvent } from '../shared/types.js'

type Json = Record<string, any>

const short = (s: unknown, n = 140) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : undefined)

// Turns a tool hook's JSON (Claude Code or Cursor) into an activity event. Only the action's name and the
// file path or command line are kept; prompts, file contents and tool output are never stored.
export function hookToEvent(raw: unknown, sourceHint?: string): HHEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const h = raw as Json
  const name: string = h.hook_event_name ?? h.hookEventName ?? h.event ?? ''
  const source = sourceHint ?? (h.conversation_id || h.workspace_roots ? 'cursor' : 'claude-code')
  const input: Json = h.tool_input ?? h.toolInput ?? {}
  const tool: string | undefined = h.tool_name ?? h.toolName ?? toolFromHook(name)
  const file: string | undefined = input.file_path ?? input.path ?? input.notebook_path ?? h.file_path
  const command: string | undefined = input.command ?? h.command
  const cwd: string | undefined = h.cwd ?? (Array.isArray(h.workspace_roots) ? h.workspace_roots[0] : undefined)
  const session: string | undefined = h.session_id ?? h.conversation_id

  // Which agent acts, and which skill it runs. Claude Code names the subagent on its hooks
  // (agent_type), on SubagentStart, and in the Task or Agent tool's subagent_type; a skill is the
  // Skill tool's input.
  const isSkill = /^skill$/i.test(tool ?? '')
  const skill: string | undefined = isSkill ? short(input.skill ?? input.command ?? input.name, 80) : undefined
  const spawned: string | undefined = /^(task|agent)$/i.test(tool ?? '') ? short(input.subagent_type, 60) : undefined
  const role: string | undefined = short(h.agent_type ?? h.subagent_type, 60)

  let detail: string | undefined
  const lname = name.toLowerCase()
  if (skill) detail = 'Running skill ' + skill
  else if (spawned) detail = 'Started agent ' + spawned + (input.description ? ': ' + short(input.description, 80) : '')
  else if (/subagent/.test(lname)) detail = (/stop/.test(lname) ? 'Subagent finished' : 'Subagent started') + (h.agent_type || h.subagent_type ? ': ' + (h.agent_type ?? h.subagent_type) : '')
  else if (/^stop$|sessionend|session_end/.test(lname)) detail = 'Agent stopped'
  else if (/sessionstart|session_start/.test(lname)) detail = 'Session started'
  else if (/notification/.test(lname)) detail = 'Waiting for you: ' + (short(h.message, 100) ?? 'notification')
  else if (command) detail = 'Running ' + short(command, 120)
  else if (file) detail = (tool ? tool + ' ' : 'Editing ') + file
  else if (tool) detail = tool + (input.description ? ': ' + short(input.description, 100) : input.pattern ? ' ' + short(input.pattern, 80) : '')
  if (!detail) return undefined

  return {
    v: 1, ts: new Date().toISOString(), kind: 'activity', source, tool, detail,
    session: typeof session === 'string' ? session.slice(0, 120) : undefined,
    cwd: typeof cwd === 'string' ? cwd : undefined,
    files: typeof file === 'string' ? [file] : undefined,
    agent: role ? { role } : undefined,
    skill,
  }
}

function toolFromHook(name: string): string | undefined {
  const n = name.toLowerCase()
  if (n.includes('shell')) return 'Shell'
  if (n.includes('fileedit')) return 'Edit'
  if (n.includes('readfile')) return 'Read'
  if (n.includes('mcp')) return 'MCP'
  return undefined
}
