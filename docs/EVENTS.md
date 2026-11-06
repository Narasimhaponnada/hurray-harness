# Event contract (v1)

Any harness, script or tool hook reports into the hub by posting JSON to `POST /api/events` (one event or a list of up to 500). The hub keeps only the fields below and drops everything else, so prompts, file contents and tool output can never be stored by accident.

```bash
hh emit '{"kind":"step.start","ticket":42,"lane":"L1","step":"code","agent":{"role":"developer","model":"sonnet"},"skill":"feature-build","detail":"Building cursor pagination"}'
```

## Fields

| Field | Type | Meaning |
|---|---|---|
| `kind` | string, required | One of the kinds below |
| `ts` | ISO time | When it happened. Defaults to the time the hub receives it |
| `source` | string | Who sent it: your harness's name, `claude-code`, `cursor`, `cli` |
| `user`, `machine` | string | Who and where. `hh emit` fills these in. Kept so a team view can merge everyone's events later |
| `repo` | `owner/name` | The repository |
| `run` | string | One harness run (one milestone of one repo) |
| `milestone`, `mode`, `stage` | string | Run details. A `stage` such as Plan, Build, Test or Release lights the matching phase |
| `phase` | string | An SDLC phase: Discovery, Design, Architecture, Plan, Build, Promote, Test, Release, Launch |
| `lane` | string | `L1`, `L2`, `QA` … one row in the swimlanes |
| `ticket`, `epic` | number | Issue numbers. `"#42"` is accepted |
| `title` | string | The ticket's title |
| `step` | string | Build steps: `plan`, `code`, `tests`, `check`, `pr`, `review`, `merge`, `close`. Test steps: `qa-plan`, `cycle-open`, `run`, `second-look`, `file-bugs`, `verify`, `cycle-close`, `sign-off`. Any other name is shown as is |
| `agent` | `{role, model?, name?}` or a role string | The agent doing the step |
| `skill` | string | The skill, playbook or prompt the agent runs |
| `status` | string | `waiting`, `running`, `done`, `failed`, `blocked`, `skipped` |
| `attempt` | number | Recode attempt. Counted automatically when a step starts again |
| `detail` | string | One line: what the agent is doing now |
| `files` | string[] | Paths touched in this step (paths only, at most 20) |
| `tokens` | `{used, budget}` | Budget meter in the step detail |
| `pr`, `branch` | number, string | The step's PR and branch |
| `session`, `cwd`, `tool` | string | From tool hooks. `cwd` ties an event to a worktree, and so to its ticket |
| `decision` | `{id, title, why?, recommendation?, url?}` | For decision events |

## Kinds

| Kind | Use |
|---|---|
| `run.start`, `run.stage`, `run.end` | A run begins, moves stage, ends. Stages light up the phase strip |
| `phase` | Set a phase's status directly (for phases outside a run, such as Discovery) |
| `step.start`, `step.end` | One agent step on one ticket. These build the lane grid, the swimlanes and the agent list |
| `decision.open`, `decision.close` | Something waits on a person. It goes to the top of the dashboard, with a desktop notification |
| `activity` | A raw action from a tool hook. Shown in the activity list and as "doing now" on the ticket's running step |

## Rules the hub applies

- A step that starts again after it ended counts as the next attempt, shown as "recode 2".
- An `activity` event with a ticket, or with a `cwd` or file inside a lane's worktree, updates that ticket's running step.
- A row leaves the grid 30 minutes after its `close`, `cycle-close` or `sign-off` step is done.
- Events are kept for 14 days in `~/.hurray-harness/events.db` (SQLite).
