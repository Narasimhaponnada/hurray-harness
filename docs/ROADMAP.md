# Roadmap

## v1 (this release): personal view

- Local hub (Node 22, Hono, built-in SQLite, Server-Sent Events) on `127.0.0.1`
- Dashboard with these sections:
  - decisions,
  - SDLC phases with skills,
  - GitHub milestone, board, epics and issues,
  - lane grid with step detail,
  - swimlanes,
  - worktree-to-merge graph,
  - agents,
  - activity.
- GitHub through `gh` (read-only), plus local git worktrees
- Claude Code and Cursor hooks; any harness through events or `hh step`
- Demo mode

## v2

- **GitLab adapter.** Issues, epics, milestones and iterations, merge requests and pipelines, through `glab` or the REST API.
- **Jira adapter.** Stories, epics, fix versions and sprints, and linked PRs or MRs from the development panel.
- **Cursor and VS Code extension.** The dashboard in a webview panel; one extension covers both.
- **Claude Code pane.** A thin mod that shows the dashboard beside the chat.

## v3: team

- **Team server.** Postgres instead of SQLite, sign-in, and every person's hub sending its event log (status only, never content).
- **Read-only MCP server.** Agents in any tool can ask "who holds #47?" or "what is decided about tenancy?". Answers come from the repo and the tracker, not from a separate memory.
- **Alerts in Slack or Teams.** For decisions that wait on a person.

Every adapter implements `TrackerAdapter` in `src/hub/trackers/index.ts` and maps onto the common model in `src/shared/types.ts`.
