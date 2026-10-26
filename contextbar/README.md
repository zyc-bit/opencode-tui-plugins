# contextbar — OpenCode TUI context usage bar

A dual-entry plugin (server + TUI) that renders a context-usage progress bar
above the input box (`session.composer.top`) showing how the model's context
window is spent.

```
████████░░░░░░░░░░░░░░░░░░░░ 346k/512k · 68%
■ ~system prompt 368 0.1%   ■ ~system tools 3.1k 0.6%   ■ ~memory files 4.6k 0.9%   ■ ~skills 845 0.2%   ■ messages 346k 68%   ─ free 128k   ░ autocompact buffer 32k
```

## How it works

The bar **partitions** the provider-exact context total — the same number
OpenCode's own usage display shows (last assistant tokens:
input+output+reasoning+cache.read+cache.write). Since every model request
re-sends the full prompt, that total already contains the system prompt,
tools, and instructions; the measured chars/4 estimates carve those parts out
and the remainder is the conversation proper. The bar's total therefore always
matches the built-in display.

| Segment | Source | Precision |
| --- | --- | --- |
| (total anchor) | last assistant tokens (after compaction, before revert) | exact (provider) |
| system prompt | server hook measures assembled `system[0]` chars, carved from total | chars exact, tokens = chars/4 |
| system tools | server hook measures Σ(name+description+schema), carved from total | chars exact, tokens = chars/4 |
| memory + skills | `system[1]` (merged instructions) minus injected-skills estimate, carved | approx |
| messages | total − carved statics (conversation remainder) | exact remainder |
| free / window | `ui.model.current()` → `limit.context` | exact |
| autocompact buffer | `client.config.get()` → `compaction.buffer` | exact |

`~` marks estimated segments. chars/4 is OpenCode's own internal calibration
(its autocompact logic uses the same formula), so the bar's view matches the
server's compaction decisions.

## Architecture (single package, dual entry)

- `index.ts` (server): `session.hook("context")` measures every agent-loop
  model request and publishes `rpc.contextbar.measured` events; a 5 s
  `rpc.contextbar.snapshot` heartbeat covers TUI restarts (events are
  live-only).
- `tui.tsx` (client): subscribes to the events via `data.on`, reads messages /
  model window / skills from the reactive data layer, renders the bar.

> RPC method calls are location-scoped by design: a request without an
> explicit `location` falls back to the server process's working directory,
> where project plugins are not loaded (`rpc.unavailable`). Calls must pass
> `?location[directory]=<project>`, the `x-opencode-directory` header, or
> `client.rpc(Contract).method(input, { location })` — the RPC guide's
> examples omitted this (upstream docs patch pending, see
> [opencode#58438](https://github.com/anomalyco/opencode/issues/58438)).
> This plugin uses events instead because they broadcast across locations,
> which suits a broadcast-style consumer — and it avoids the live-only
> bootstrap problem with a 5 s snapshot heartbeat.

## Files

- `index.ts` — server entry: hook measurement + event emission
- `tui.tsx` — TUI entry: `session.composer.top` slot + rendering
- `core.ts` — pure logic: reference-message pick, bar layout, formatting
- `rpc.ts` — shared RPC event contract

No configuration; the bar appears above the input once a session has context
data.
