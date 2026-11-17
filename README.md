# Rollcall

A Mac menu bar app that lists every Claude Code session running on this machine (terminal, desktop app, IDE extensions) with its project, goal, ticket and status, and a local MCP server that gives Claude the same list.

Everything stays on this Mac. Nothing here makes a network call.

## Run it

```bash
npm install
npm run hooks:install   # adds the hook entries to ~/.claude/settings.json
npm start               # menu bar app
```

Sessions report in from their next event, so restart sessions that were already open or send them a prompt.

| Command | What it does |
| --- | --- |
| `npm start` | Builds and opens the menu bar app |
| `npm test` | Builds and runs the tests |
| `npm run hooks:install` / `hooks:uninstall` / `hooks:status` | Manages the entries in `~/.claude/settings.json` |
| `npm run daemon` | Keeps `sessions.json` current without the menu bar app |
| `npm run mcp` | Runs the MCP server on stdio (Claude starts it for you once registered) |

## Connect the MCP server

```bash
claude mcp add --scope user rollcall -- node "$(pwd)/dist/src/mcp/server.js"
```

Tools: `list_tasks` (optional `client` filter), `list_sessions` (optional `status` filter) and `get_session`. The server folds any events the app has not processed yet, so it answers correctly with the app closed.

## Today's tasks

The top of the popover is a to-do list for the day. Each task has an optional client and is grouped under it.

- A task shows the status of the sessions working on it: waiting for input, working, finished, idle or not started. With several sessions, the most urgent wins.
- A session links to a task automatically when the task title names the session's ticket (`SHOP-123`), or by hand from the session's Edit form.
- Open tasks carry over to the next day. Ticked tasks drop off the next day.
- A project's client is set once in a session's Edit form and applies to every session in that folder.

Tasks live in `~/.claude-monitor/tasks.json`. The MCP tool `list_tasks` returns the same list, plus the running sessions that are not linked to any task.

## How it works

1. `~/.claude-monitor/hook.sh` runs on each session event and appends one line to `~/.claude-monitor/events.jsonl`. It takes about 35 ms, prints nothing and always exits 0.
2. The app polls that file twice a second, folds events into one record per session and writes `~/.claude-monitor/sessions.json`.
3. The popover and the MCP server read that state. Goal, ticket and project-name edits live in `overrides.json`.

| Event | Status |
| --- | --- |
| `SessionStart` | idle until the first prompt ("No prompt yet") |
| `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure` | working |
| `PermissionRequest`, `Notification` (permission, elicitation, background agent), `PreToolUse` for `AskUserQuestion` / `ExitPlanMode` | waiting for input |
| `Stop`, `StopFailure` | finished |
| `SessionEnd` | removed |
| No event for 30 minutes | idle (a session waiting on you keeps saying so) |
| No event for 12 hours | dropped |

## Settings

Optional `~/.claude-monitor/config.json`:

```json
{ "idle_minutes": 30, "drop_after_hours": 12, "rotate_mb": 5, "ticket_prefixes": ["SHOP", "BLOG"] }
```

With `ticket_prefixes` empty, any `ABC-123` key is detected from the branch name, then the first prompt.

## Layout

| Path | Contents |
| --- | --- |
| `src/hook/hook.ts` | The hook. Self-contained, Node built-ins only |
| `src/cli/install.ts` | Installer and uninstaller for the settings entries |
| `src/shared/fold.ts` | Pure event-to-status rules |
| `src/shared/store.ts` | Event log reading, rotation, `sessions.json`, edits |
| `src/shared/transcript.ts` | The only code that reads the undocumented transcript format |
| `src/mcp/server.ts` | MCP server |
| `src/app/`, `ui/` | Electron menu bar app |

## Licence

MIT. See [LICENSE](LICENSE).
