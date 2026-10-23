# Radar — OpenCode TUI subagent monitor

A CLI plugin panel for OpenCode v2 that tracks the subagents (child sessions)
spawned by the current session. Open it with the `/radar` slash command or from
the command palette ("Radar: subagent monitor").

## Features

- Live list of the session's subagents as a **collapsible tree** (any depth:
  subagents of subagents included), each node a rounded card
- Identity (agent · model · status icon · fold twisty) in the card's border
  title, usage line, task title, and current tool action inside
- Card border color signals state at a glance: accent when selected,
  info-blue while running, warning-amber while waiting for permission, faint
  when vanished
- Status lights: `◉` running · `⚠` waiting for permission · `○` idle · `◌` stale ·
  `✓` succeeded · `✗` failed · `⏹` interrupted · `·` vanished (deleted, kept as
  a dimmed ghost for 30 minutes)
- Per-subagent: agent + model, tokens (in→out), elapsed time or finish clock,
  tool-call count, and the tool currently executing (name + argument summary)
- Overview bar: totals, aggregate tokens/cost, tool calls, wall time
- Detail view (Enter) with token/cost/tool breakdown and span
- Event-driven refresh (250 ms throttled), follows the active session

## Keys

| Key | Action |
| --- | --- |
| `j` / `k`, arrows | select subagent |
| `Enter` | toggle detail view |
| `h` / `l` | collapse / expand the selected subtree |
| `s` | toggle sort order (status / recent) |
| `x` | interrupt the selected subagent (asks for confirmation) |
| `o` | open selected subagent in a tab (needs tabs enabled) |
| `f` | toggle fullscreen panel |
| `Esc` / `c` | close panel |

The host has no universal escape-to-close binding, so radar registers its own
(the built-in diff panel does the same). `ctrl+x ←` (`pane.focus.left`) moves
focus back to the prompt; `ctrl+x →` focuses the panel again.

## Notifications

When a subagent finishes (`succeeded` / `failed` / `interrupted`), radar shows
a toast — clicking it (or its open action) jumps to that subagent's session —
and sends a system notification while the terminal is blurred.

- `/radar notify off` — disable completion notifications
- `/radar sound on` — also play a sound (`subagent_done` / `error`)
- `/radar status` — show current settings

Preferences persist across restarts (durable storage, live-synced between TUI
instances). Sound defaults to off because the host may already play completion
sounds.

## Install

Project-local discovery: this directory (`.opencode/plugins/radar/`) is picked
up automatically. The TUI hot-reloads changes to these files — no restart
needed. For other projects, copy the directory or load it via `cli.json`
(`"plugins": ["path/to/radar"]`) or `opencode.json(c)`.

## Files

- `tui.tsx` — plugin entry: `/radar` command, `session.panel` slot, UI
- `model.ts` — child-session extraction, status derivation, tool scanning
- `format.ts` — token/cost/duration formatting, CJK-aware truncation
