// contextbar server plugin: measures the assembled system prompt and tool
// definitions on every agent-loop model request and publishes the result as
// RPC events (`rpc.contextbar.measured` / `.snapshot`). Token conversion is
// chars/4 downstream — the same calibration OpenCode's own autocompact uses.

import { Plugin } from "@opencode/plugin"
import { ContextbarRpc, type Measurement } from "./rpc"

const SNAPSHOT_INTERVAL_MS = 5000

interface SystemPartLike {
  type?: string
  text?: string
}

interface ToolLike {
  description?: string
  input?: unknown
}

interface ContextHookEvent {
  readonly sessionID: string
  readonly model: { providerID: string; id: string }
  system: SystemPartLike[]
  tools: Record<string, ToolLike>
}

function jsonLen(value: unknown): number {
  if (value === undefined) return 0
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

export default Plugin.define({
  id: "contextbar",
  async setup(ctx) {
    /** sessionID -> latest measurement; insertion-ordered, bounded. */
    const latest = new Map<string, Measurement>()

    const hook = await ctx.session.hook("context", (event) => {
      const e = event as unknown as ContextHookEvent
      let systemChars = 0
      let instructionsChars = 0
      const parts = Array.isArray(e.system) ? e.system : []
      parts.forEach((part, index) => {
        const length = typeof part?.text === "string" ? part.text.length : 0
        if (index === 0) systemChars = length
        else instructionsChars += length
      })
      let toolsChars = 0
      let toolCount = 0
      for (const [name, tool] of Object.entries(e.tools ?? {})) {
        toolCount++
        toolsChars += name.length + (tool?.description?.length ?? 0) + jsonLen(tool?.input)
      }
      const measurement: Measurement = {
        sessionID: e.sessionID,
        systemChars,
        instructionsChars,
        toolsChars,
        toolCount,
        providerID: e.model?.providerID ?? "",
        modelID: e.model?.id ?? "",
        at: Date.now(),
      }
      latest.set(e.sessionID, measurement)
      if (latest.size > 200) {
        const oldest = latest.keys().next().value
        if (oldest !== undefined) latest.delete(oldest)
      }
    })

    const registration = await ctx.rpc.register(ContextbarRpc, {})

    const emit = (event: "measured" | "snapshot", data: unknown) => {
      void registration.events
        .emit(event, data as never)
        .catch(() => {})
    }

    // Heartbeat so freshly started TUIs learn existing measurements
    // (RPC events are live-only).
    const heartbeat = setInterval(() => {
      if (latest.size === 0) return
      emit("snapshot", { measurements: [...latest.values()] })
    }, SNAPSHOT_INTERVAL_MS)

    return () => {
      clearInterval(heartbeat)
      void hook.dispose()
      void registration.dispose()
      latest.clear()
    }
  },
})
