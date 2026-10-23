# opencode-tui-plugins

TUI plugins for [OpenCode](https://opencode.ai) v2 — a subagent monitor panel
and a context usage bar, both hot-reloadable and dependency-free at runtime.

| Plugin | What it does | Entry |
| --- | --- | --- |
| [radar](./radar) | `/radar` panel tracking the session's subagents as collapsible cards: live status, tokens, cost, current tool, interrupt/jump actions, completion notifications | TUI only |
| [contextbar](./contextbar) | Context usage bar above the input box: segments for system prompt / tools / memory / skills / messages, free space, and the autocompact buffer | server + TUI |

Requires OpenCode **v2.1.3+** (developed and verified against it).

## Install

Clone, then copy a plugin directory into your project or global plugin folder
(OpenCode discovers both automatically):

```sh
git clone https://github.com/zyc-bit/opencode-tui-plugins.git
cd opencode-tui-plugins

# project-local (this project only)
cp -r radar contextbar /path/to/project/.opencode/plugins/

# or global (every project)
cp -r radar contextbar ~/.opencode/plugins/
```

Alternatively reference the checkout directly in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    "/path/to/opencode-tui-plugins/radar",
    "/path/to/opencode-tui-plugins/contextbar"
  ]
}
```

No build step and no dependencies — OpenCode transpiles the sources at load
time and hot-reloads on every edit.

## radar — subagent monitor

Open with `/radar` (or the command palette). Shows every subagent spawned by
the current session as a rounded card whose border color signals state
(running / waiting for permission / done / failed / vanished), with a
collapsible tree for nested subagents, per-agent tokens/cost/tool stats, the
tool currently executing, and the current permission wait.

Keys: `j/k` select · `Enter` details · `h/l` fold · `x` interrupt · `s` sort ·
`f` fullscreen · `Esc` close. Preferences: `/radar notify off`, `/radar sound
on`, `/radar status`. Details in [radar/README.md](./radar/README.md).

## contextbar — context usage bar

Renders above the input box:

```
███████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 346k/512k · 68%
■ ~system prompt 368 0.1%  ■ ~system tools 3.1k 0.6%  ■ ~memory files 4.6k 0.9%  ■ ~skills 845 0.2%  ■ messages 340k 66%  ─ free 128k  ░ autocompact buffer 32k
```

The total is the provider-exact usage (identical to OpenCode's built-in
display); segments partition it. Static parts are measured in chars by a
companion server plugin (`session.hook("context")`) and converted with
OpenCode's own chars/4 calibration; see
[contextbar/README.md](./contextbar/README.md) and
[docs/contextbar-design.md](./docs/contextbar-design.md) for the architecture
notes, including a v2.1.3 quirk where HTTP RPC method calls can't see plugin
registrations (events work fine).

## Development

Each plugin is plain TypeScript (TSX for UI) with a local `tsconfig.json` for
editor/type checking. Type-check against the real SDK with:

```sh
npm i @opencode/plugin@2.1.3 @opentui/core @opentui/solid solid-js typescript
npx tsc --noEmit
```

## License

[MIT](./LICENSE)
