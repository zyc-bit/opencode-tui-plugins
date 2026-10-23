// Server entry for opencode-subagent-radar. The radar panel is implemented
// entirely in the TUI entry (./tui); this stub keeps the documented dual
// package shape so `opencode plugin add` and config loading work uniformly.
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "radar.server",
  setup() {
    // nothing to do server-side
  },
})
