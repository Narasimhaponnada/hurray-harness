# Decisions on your phone, through the Claude app

The simplest way to answer the harness from your phone. A Claude Code session on your machine watches the hub. When a decision opens, it sends a push notification to the Claude app on your phone and asks you there. Your answer goes back to the harness.

There's no webhook, tunnel or public URL, and nothing on your machine accepts connections from outside. Only someone signed in to your Claude account can answer.

## How it works

```
harness ──hh ask --wait──▶ hub ◀──hh decisions --follow── Claude Code session (Remote Control on)
   ▲                        ▲                                   │ push notification + question
   │ prints the choice      └──────────hh answer────────────────┤
   └────────────────────────────────────────────────────────────┘◀── you answer in the Claude app
```

1. Your harness asks: `hh ask "Pick the database" --option Postgres --option SQLite --wait`.
2. The decision-watcher skill, running in a Claude Code session, reads `hh decisions --follow`, which prints one line per decision that opens.
3. Claude sends a push notification ("Decision waiting: Pick the database") and asks you, with the options and the recommended one marked.
4. You tap the notification, open the session in the Claude app, and pick an option.
5. Claude runs `hh answer`, and `hh ask --wait` prints your choice to the harness.

## Set it up

You need the hurray-harness plugin, the hub running (`hh start`), and the Claude app on your phone, signed in with the same claude.ai account as Claude Code.

1. **Start a Claude Code session with Remote Control on.** Run `claude remote-control`, or `/remote-control` in a session that is already open.
2. **Turn on mobile push** in `/config`, so Claude can notify your phone.
3. **Start the watcher.** In that session, run `/hurray-harness:decision-watcher`, or say "watch decisions".
4. **Open the session once on your phone** (Claude app → Code), so you know where questions land.

Leave the session open. It keeps watching until you tell it to stop.

## What to expect

- **Your computer stays on.** Remote Control drives a session on your machine, as does the hub. If the machine sleeps, the session reconnects when it wakes.
- **A claude.ai account is required.** Remote Control and push are not available with a Console API key or through a cloud provider such as Bedrock. Your plan or organisation must include them.
- **Each decision uses a few tokens**, because Claude reads the line and asks you.
- **What Claude asks you:**
  - **Decisions with options** become a multiple-choice question. Up to 4 options show as choices; with 5 or 6, Claude lists them in a message.
  - **Decisions without options** become a question you answer in your own words.
  - **Tracker items** (a label, a blocked issue, an approval PR) come as a notification with a link, because you answer those on GitHub.
- **The first answer wins.** If you answer on the dashboard or with `hh answer` first, Claude tells you it was settled elsewhere.

## Without the skill

`hh decisions` works from any script or tool:

```bash
hh decisions                     # what waits on you now
hh decisions --follow            # one readable line per change, until stopped
hh decisions --follow --json     # one JSON object per line, for scripts and agents
```

Each JSON line has `type` (`open`, `answered`, `closed`, or `hub` for offline and back), `id`, `title`, `why`, `recommendation`, `options`, `url`, `ticket`, `answerable`, and, once answered, `choice` and `via`.

## Other ways to answer

- **On this computer:** the dashboard's answer buttons, or `hh answer <id> <option>`.
- **Microsoft Teams,** for people who don't use Claude Code: see [TEAMS.md](TEAMS.md).
