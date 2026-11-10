# Integrations

The hub listens on `http://127.0.0.1:7311` and only accepts writes from this machine. Every integration below is fire-and-forget with a one-second limit: if the hub is not running, agents carry on unaffected.

There are three levels. Each adds detail; use as many as suit your harness.

| Level | What you do | What you get |
|---|---|---|
| 1. Nothing | Start the hub in your repo | A lane for every issue in flight, built from GitHub and git (below); the milestone, board, epics, issues and PRs; every worktree and its path to a merge; decisions from labels and approval PRs |
| 2. Agent activity | The Claude Code plugin, or a hook file | On each lane: the agent, its skill, what it does now, and the recode loop |
| 3. Harness events | Wrap steps with `hh step`, or post events | Your harness's own steps, models, token budgets, phases and swimlanes |

## Level 1: lanes from GitHub and git

Every open issue that is in progress, in review, in QA or blocked on the board, or that has a worktree or an open PR, gets a row in the grid. Its cells come from what is already there:

| Step | Comes from |
|---|---|
| Plan | Done once work started: a board status past to-do, a worktree, a PR or agent activity |
| Code | Working until the PR is ready for review; working again (recode 2) when checks fail or changes are requested and an agent is back at it |
| Tests, Check | The PR's checks: running, failed or done |
| PR and gate | The PR: a draft is working, ready is done |
| Review | Working once checks pass (or the board says review); failed on changes requested; done on approval |
| Merge | Failed on a conflict; working when approved and green; done when merged |
| Close or QA | Working after the merge while the issue is open (QA); done when the issue closes |

A blocked issue (a label or a board column such as Blocked) shows amber where it stopped. Merged and closed issues stay for a day. A ticket your harness reports on with `hh step` keeps the harness's row instead.

## Level 2: agent activity

**Claude Code: install the plugin.** It sends the hub one line for each edit, command, skill and subagent: the tool, the file path or command line, the skill name, and which subagent acted. Never file contents, prompts or output. Each line lands on its ticket through the worktree of the file or folder it touched. Set `HH_REPORT=0` to turn it off. Without the plugin, use the hook file below instead.

**Claude Code.** Merge [`integrations/claude-code/settings.json`](../integrations/claude-code/settings.json) into `.claude/settings.json` in the repo, or into `~/.claude/settings.json` for every repo. It forwards Bash commands, file edits, skills, subagent stops, notifications and stops.

**Cursor.** Copy [`integrations/cursor/hooks.json`](../integrations/cursor/hooks.json) to `.cursor/hooks.json` in the repo, or to `~/.cursor/hooks.json`. It uses Cursor's after-hooks (shell, file edit, MCP, subagent start and stop, stop), so it never holds up an action.

**Any other tool with hooks.** Post the hook's JSON to `/api/hook/<tool-name>`. The hub reads the common fields (`hook_event_name`, `tool_name`, `tool_input.file_path`, `tool_input.command` or `command`, `cwd`, `session_id`).

Only the action's name, the file path or the command line are kept. Prompts, file contents and tool output are dropped.

How tickets are found: a lane's worktree branch is named with its ticket number (`feat/42-pagination`, `fix/71-limit`, `42-thing`), so any event whose `cwd` or file sits in that worktree belongs to ticket #42.

## Level 3: harness events

### Wrap a step with `hh step`

The least code. Put `hh step` in front of the commands your harness already runs:

```bash
hh step --ticket 42 --lane L1 --step check --agent developer --skill feature-build -- npm test
hh step --ticket 42 --lane L1 --step pr --agent developer -- gh pr create --fill
```

It reports the step started, runs the command with its output untouched, then reports done or failed from the exit code. It exits with the command's own exit code, so the wrapped command behaves exactly as before.

### Post events

For full control (agent model, token budget, decisions, run stages), post events in the [event contract](EVENTS.md) from your harness, or use `hh emit` from a script:

```bash
hh emit '{"kind":"run.start","run":"r1","repo":"me/app","milestone":"0.2","stage":"Build","skill":"feature-build"}'
hh emit '{"kind":"step.start","run":"r1","repo":"me/app","ticket":12,"lane":"L1","step":"code","agent":{"role":"developer","model":"sonnet"},"tokens":{"used":0,"budget":120000}}'
hh emit '{"kind":"decision.open","decision":{"id":"r1-pick-db","title":"Pick the database","recommendation":"Postgres"}}'
```

From code, it is one HTTP call:

```js
fetch('http://127.0.0.1:7311/api/events', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'step.end', ticket: 12, lane: 'L1', step: 'code', status: 'done' }),
}).catch(() => {}) // never let monitoring break the agent
```

If your harness runs where it cannot make network calls (some workflow engines replay scripts and forbid side effects), send events from the scripts or commands its agents call instead, using `hh step` or `hh emit`.

## Asking a person and waiting for the answer

When your harness needs a person to choose, ask with options and wait. The answer can come from the dashboard, from `hh answer`, or from your phone through Microsoft Teams ([TEAMS.md](TEAMS.md)):

```bash
choice=$(hh ask "Pick the database" --option Postgres --option SQLite --recommend Postgres --ticket 12 --wait --timeout 3600)
```

The command prints the option picked and exits 0, so a script can branch on it. Exit codes are 3 on timeout (or use `--default`) and 1 when no hub is running.

## Decisions from the tracker

The hub raises "needs your decision" items on its own from:

- **Decision labels.** Issues with a decision label. Defaults: `needs-human`, `needs-decision`, `needs-review`, `question`.
- **Blocked issues.** Issues in a Blocked board column, or with a blocked label.
- **Approval PRs.** Pull requests into an approval branch, such as `main`, `stage` or `release`. Set these with `--approval main` (repeatable) or `approvalBranches` in `hh.config.json`.

Label names are configurable in `hh.config.json`, under `labels`: `decision`, `blocked`, `qa`, `inProgress` and `ready`. They also set the board column for issues that are not on a project board.
