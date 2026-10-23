/** @jsxImportSource @opentui/solid */
// contextbar TUI plugin: renders a context-usage progress bar above the input
// box (session.composer.top). Exact data comes from the reactive data layer
// (messages tokens, model window, autocompact buffer); system/tools/instructions
// chars come from the companion server plugin via polled RPC.

import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { Measurement } from "./rpc"
import {
  estimateTokens,
  extractBuffer,
  formatPercent,
  formatTokens,
  layoutBar,
  pickReference,
  planBar,
  usageTotal,
} from "./core"


// ---------------------------------------------------------------------------
// Structural types (kept local so the runtime never resolves type packages)
// ---------------------------------------------------------------------------

interface LocationRefLike {
  directory?: string
}

interface TuiContext {
  readonly location: LocationRefLike | undefined
  readonly data: {
    on(type: string, handler: (event: { data?: unknown }) => void): () => void
    readonly session: {
      get(sessionID: string):
        | {
            model?: { id?: string; providerID?: string }
            revert?: { messageID?: string }
            location?: LocationRefLike
          }
        | undefined
      readonly message: { list(sessionID: string): unknown[] }
    }
    readonly location: {
      readonly model: {
        list(location?: LocationRefLike): Array<{ providerID?: string; id?: string; limit?: { context?: number } }> | undefined
      }
      readonly skill: {
        list(location?: LocationRefLike): Array<{ id?: string; name?: string; description?: string; autoinvoke?: boolean }> | undefined
      }
    }
  }
  readonly ui: {
    readonly model: { current(): { providerID: string; modelID: string } | undefined }
    slot(claim: Record<string, unknown>): () => void
  }
  readonly client: {
    config: { get(): Promise<unknown> }
  }
  readonly theme: any
}

let context: TuiContext | undefined

/** One-shot config fetch (config is not reactive). */
const [configBuffer, setConfigBuffer] = createSignal<number | undefined>(undefined)

function categorical(theme: any, index: number, fallback: unknown): any {
  const scale = theme?.categorical?.[index]
  return scale?.[400] ?? scale?.[300] ?? fallback ?? theme?.text?.muted
}

function partColor(theme: any, kind: "segment" | "buffer" | "free", colorIndex: number): any {
  switch (kind) {
    case "segment":
      return categorical(theme, colorIndex, theme?.text?.base)
    case "buffer":
      return theme?.text?.faint ?? theme?.text?.muted
    default:
      return theme?.text?.muted
  }
}

const PART_GLYPH: Record<"segment" | "buffer" | "free", string> = {
  segment: "█",
  buffer: "░",
  free: "·",
}

/** Fallback bar width before the first layout pass reports the real width. */
const FALLBACK_BAR_WIDTH = 30

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function ContextBar(props: { sessionID: string }) {
  const ctx = context!
  const [measurements, setMeasurements] = createSignal<Map<string, Measurement>>(new Map())

  // Measurements arrive as RPC events through the public event stream
  // (`rpc.contextbar.measured` per model call, `.snapshot` heartbeat for
  // late joiners). HTTP RPC method calls are unavailable on this build.
  createEffect(() => {
    const stopMeasured = ctx.data.on("rpc.contextbar.measured", (event) => {
      const m = event?.data as Measurement | undefined
      if (!m?.sessionID) return
      setMeasurements((prev) => new Map(prev).set(m.sessionID, m))
    })
    const stopSnapshot = ctx.data.on("rpc.contextbar.snapshot", (event) => {
      const payload = event?.data as { measurements?: Measurement[] } | undefined
      if (!Array.isArray(payload?.measurements)) return
      const next = new Map<string, Measurement>()
      for (const m of payload.measurements) {
        if (m?.sessionID) next.set(m.sessionID, m)
      }
      setMeasurements(next)
    })
    onCleanup(() => {
      stopMeasured()
      stopSnapshot()
    })
  })

  const measure = createMemo(() => measurements().get(props.sessionID))

  const messages = createMemo(() => {
    try {
      return (ctx.data.session.message.list(props.sessionID) ?? []) as Array<Record<string, unknown>>
    } catch {
      return []
    }
  })

  const session = createMemo(() => {
    try {
      return ctx.data.session.get(props.sessionID)
    } catch {
      return undefined
    }
  })

  const location = createMemo(() => session()?.location ?? ctx.location)

  const limit = createMemo(() => {
    let providerID: string | undefined
    let modelID: string | undefined
    try {
      const current = ctx.ui.model.current()
      if (current) {
        providerID = current.providerID
        modelID = current.modelID
      }
    } catch {
      /* model API unavailable */
    }
    const sessionModel = session()?.model
    providerID ??= sessionModel?.providerID
    modelID ??= sessionModel?.id
    if (!providerID || !modelID) return undefined
    let models: Array<{ providerID?: string; id?: string; limit?: { context?: number } }> = []
    try {
      models = ctx.data.location.model.list(location()) ?? []
    } catch {
      return undefined
    }
    return models.find((m) => m.providerID === providerID && m.id === modelID)?.limit?.context
  })

  // Skills estimate: exactly what the skill service injects (id+name+description).
  const skillsTokens = createMemo(() => {
    let skills: Array<{ id?: string; name?: string; description?: string; autoinvoke?: boolean }> = []
    try {
      skills = ctx.data.location.skill.list(location()) ?? []
    } catch {
      return undefined
    }
    let chars = 0
    let any = false
    for (const skill of skills) {
      if (!skill.description || skill.autoinvoke === false) continue
      chars += (skill.id?.length ?? 0) + (skill.name?.length ?? 0) + skill.description.length
      any = true
    }
    return any ? estimateTokens(chars) : undefined
  })

  const usedTokens = createMemo(() => {
    const reference = pickReference(
      messages().map((m) => m as never),
      session()?.revert?.messageID,
    )
    return reference?.tokens ? usageTotal(reference.tokens) : undefined
  })

  const plan = createMemo(() => {
    const m = measure()
    const instructionsTokens = m ? estimateTokens(m.instructionsChars) : undefined
    const skills = skillsTokens()
    return planBar({
      systemTokens: m ? estimateTokens(m.systemChars) : undefined,
      toolsTokens: m ? estimateTokens(m.toolsChars) : undefined,
      memoryTokens: instructionsTokens !== undefined ? Math.max(0, instructionsTokens - (skills ?? 0)) : undefined,
      skillsTokens: skills,
      // provider-exact total — the same number the built-in footer shows
      totalTokens: usedTokens(),
      limit: limit(),
      buffer: configBuffer(),
    })
  })

  const summary = createMemo(() => {
    const p = plan()
    if (p.limit === undefined) return `${formatTokens(p.used)} ctx`
    return `${formatTokens(p.used)}/${formatTokens(p.limit)} · ${formatPercent(p.used, p.limit)}`
  })

  // The bar fills the full composer width: the row box is stretched by the
  // slot host, and onSizeChange reports the laid-out width after each resize.
  const [rowWidth, setRowWidth] = createSignal(0)
  const barWidth = createMemo(() => {
    const width = rowWidth()
    if (width <= 0) return FALLBACK_BAR_WIDTH
    // summary is ASCII-only (formatTokens/formatPercent), so length == columns
    return Math.max(10, width - summary().length - 1)
  })
  const bar = createMemo(() => layoutBar(plan(), barWidth()))
  // Only render when anchored on the provider-exact total, so the bar never
  // disagrees with the built-in usage display.
  const visible = createMemo(() => plan().exact && plan().segments.length > 0)

  return (
    <Show when={visible()}>
      <box flexDirection="column" paddingBottom={1}>
        <box
          flexDirection="row"
          onSizeChange={function (this: any) {
            const width = this?.width
            if (typeof width === "number" && width > 0) setRowWidth(width)
          }}
        >
          <For each={bar()}>
            {(part) => (
              <text fg={partColor(ctx.theme, part.kind, part.colorIndex)}>
                {PART_GLYPH[part.kind].repeat(part.cols)}
              </text>
            )}
          </For>
          <text fg={ctx.theme?.text?.muted}> {summary()}</text>
        </box>
        <box flexDirection="row">
          <For each={plan().segments}>
            {(segment, index) => (
              <text fg={categorical(ctx.theme, index(), ctx.theme?.text?.base)}>
                {`■ ${segment.approx ? "~" : ""}${segment.label} ${formatTokens(segment.tokens)} ${formatPercent(segment.tokens ?? 0, plan().limit)}   `}
              </text>
            )}
          </For>
          <Show when={plan().free > 0}>
            <text fg={ctx.theme?.text?.muted}>{`─ free ${formatTokens(plan().free)}   `}</text>
          </Show>
          <Show when={plan().buffer > 0}>
            <text fg={ctx.theme?.text?.faint ?? ctx.theme?.text?.muted}>
              {`░ autocompact buffer ${formatTokens(plan().buffer)}`}
            </text>
          </Show>
        </box>
      </box>
    </Show>
  )
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "contextbar",
  setup(tuiContext) {
    context = tuiContext as TuiContext

    // Fetch the autocompact buffer once; config is not reactive.
    void context.client.config
      .get()
      .then((entries) => {
        const parsed = extractBuffer(entries as never)
        if (parsed !== undefined) setConfigBuffer(parsed)
      })
      .catch(() => {})

    const release = context.ui.slot({
      append: "session.composer.top",
      render: (input: { sessionID: string }) => <ContextBar sessionID={input.sessionID} />,
    })

    return () => {
      release?.()
      setConfigBuffer(undefined)
      context = undefined
    }
  },
})
