/** @jsxImportSource @opentui/solid */
// Radar — a subagent monitor panel for the OpenCode TUI.
// Opens with the /radar slash command (or the command palette).
//
// Architecture:
//   - All server state is read from the TUI data layer (context.data.session*)
//   - A module-level `tick` signal invalidates memos; every server event
//     schedules one throttled tick (statusline-plugin pattern)
//   - Permission waits are tracked incrementally from events, snapshots are
//     reconciled once whenever the panel (re)attaches to a session
//   - Deleted subagents stay visible as dimmed "ghost" rows

import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import {
  aggregate,
  collectDescendants,
  deriveStatus,
  flattenTree,
  type AgentView,
  type DisplayStatus,
  type RadarData,
  type SortMode,
  type TreeRow,
} from "./model"
import {
  formatCost,
  formatDuration,
  formatShortClock,
  formatTokens,
  shortModel,
  truncateColumns,
} from "./format"

const PANEL_NAME = "radar"
const REFRESH_THROTTLE_MS = 250
const GHOST_TTL_MS = 30 * 60_000
const MAX_GHOSTS = 5

// ---------------------------------------------------------------------------
// Structural types (kept local so the runtime never resolves type packages)
// ---------------------------------------------------------------------------

interface PanelInput {
  readonly name: string
  readonly sessionID: string
  readonly width: number
  readonly presentation: "panel" | "fullscreen"
  readonly focused: boolean
  readonly focus: () => void
  readonly close: () => void
  readonly toggleFullscreen: () => void
}

interface EventDetails {
  readonly type: string
  readonly data?: {
    readonly sessionID?: string
    readonly action?: string
    readonly id?: string // permission.asked: request id
    readonly requestID?: string // permission.replied: request id
  }
}

type SyncableSession = RadarData["session"] & {
  sync(sessionID: string): Promise<void>
  message: RadarData["session"]["message"] & { sync(sessionID: string): Promise<void> }
  permission: RadarData["session"]["permission"] & { sync(sessionID: string): Promise<void> }
}

interface RadarPrefs {
  notify: boolean
  sound: boolean
  autoOpen?: boolean
}

interface TuiContext {
  readonly data: RadarData & {
    readonly session: SyncableSession
    listen(handler: (event: { details: EventDetails }) => void): () => void
  }
  readonly client: {
    session: {
      interrupt(input: { sessionID: string }): Promise<unknown>
    }
  }
  readonly theme: any
  readonly keymap: { layer(factory: () => Record<string, unknown>): void }
  readonly ui: {
    readonly panel: {
      open(name: string, options?: { presentation?: string }): boolean
      current(): { readonly name: string; readonly sessionID: string } | undefined
    }
    readonly router: {
      current(): { readonly type: string; readonly sessionID?: string }
    }
    readonly tabs: { enabled(): boolean; focus(sessionID: string): boolean }
    readonly toast: {
      show(options: { message: string; title?: string; sessionID?: string; variant?: string }): void
    }
    readonly dialog: {
      confirm(options: {
        title: string
        message: string
        label?: { confirm?: string; cancel?: string }
      }): Promise<boolean | undefined>
    }
    slot(claim: Record<string, unknown>): () => void
  }
  readonly attention: {
    notify(options: {
      title?: string
      message: string
      notification?: boolean | { when?: string }
      sound?: boolean | { name?: string; when?: string; volume?: number }
    }): Promise<{ ok: boolean }>
  }
  readonly storage: {
    store<T extends object>(
      key: string,
      options: { readonly initial: T },
    ): readonly [T, (mutation: (draft: T) => void) => Promise<void>]
  }
}

interface KeymapCommand {
  readonly id?: string
  readonly title?: string
  readonly group?: string
  readonly palette?: boolean
  readonly slash?: { readonly name: string; readonly aliases?: string[]; readonly arguments?: boolean }
  readonly bind?: string
  readonly run: (input?: string) => void | false | Promise<void>
}

// ---------------------------------------------------------------------------
// Module state (one plugin instance per TUI)
// ---------------------------------------------------------------------------

let context: TuiContext | undefined
const [tick, setTick] = createSignal(0, { equals: false })
let tickScheduled = false

function scheduleRefresh() {
  if (tickScheduled) return
  tickScheduled = true
  setTimeout(() => {
    tickScheduled = false
    setTick((t) => t + 1)
  }, REFRESH_THROTTLE_MS)
}

/** sessionID -> (permission requestID -> action label) */
const pendingPermissions = new Map<string, Map<string, string>>()

function trackPermissionAsked(sessionID: string | undefined, requestID: string | undefined, action: string | undefined) {
  if (!sessionID || !requestID) return
  let byID = pendingPermissions.get(sessionID)
  if (!byID) {
    byID = new Map()
    pendingPermissions.set(sessionID, byID)
  }
  byID.set(requestID, action ?? "permission")
}

function trackPermissionResolved(sessionID: string | undefined, requestID: string | undefined) {
  if (!sessionID) return
  const byID = pendingPermissions.get(sessionID)
  if (!byID) return
  if (requestID) {
    byID.delete(requestID)
  } else if (byID.size > 0) {
    byID.delete(byID.keys().next().value!) // legacy fallback: drop oldest entry
  }
  if (byID.size === 0) pendingPermissions.delete(sessionID)
}

/** root sessionID -> (child sessionID -> last known view + timestamp) */
const ghosts = new Map<string, Map<string, { view: AgentView; at: number }>>()

function ghostsFor(rootID: string): Map<string, { view: AgentView; at: number }> {
  let bucket = ghosts.get(rootID)
  if (!bucket) {
    bucket = new Map()
    ghosts.set(rootID, bucket)
  }
  return bucket
}

/** Bumped on every panel re-attach so stale async writes are dropped. */
let reconcileGeneration = 0

function reconcilePermissions(sessionID: string): Promise<void> {
  const generation = ++reconcileGeneration
  const data = context?.data
  if (!data) return Promise.resolve()
  let family: string[] = []
  try {
    family = data.session.family(sessionID) ?? []
  } catch {
    return Promise.resolve()
  }
  const work: Promise<unknown>[] = []
  for (const id of family) {
    try {
      work.push(data.session.sync(id).catch(() => {}))
      work.push(data.session.message.sync(id).catch(() => {}))
      work.push(
        data.session
          .permission.sync(id)
          .then(() => {
            if (generation !== reconcileGeneration) return // panel switched away
            let list: Array<{ id?: string; action?: string }> | undefined
            try {
              list = data.session.permission.list(id)
            } catch {
              list = undefined
            }
            if (list && list.length > 0) {
              const byID = new Map<string, string>()
              for (const request of list) byID.set(request.id ?? String(byID.size), request.action ?? "permission")
              pendingPermissions.set(id, byID)
            } else {
              pendingPermissions.delete(id)
            }
          })
          .catch(() => {}),
      )
    } catch {
      // data layer may throw for unknown sessions; ignore
    }
  }
  return Promise.allSettled(work).then(() => {
    if (generation === reconcileGeneration) scheduleRefresh()
  })
}

// ---------------------------------------------------------------------------
// Completion notifications (v2.1) with persisted preferences (v2.6)
// ---------------------------------------------------------------------------

let prefs: RadarPrefs | undefined
let updatePrefs: ((mutation: (draft: RadarPrefs) => void) => Promise<void>) | undefined

/** "${sessionID}:${eventType}" keys already notified this TUI run */
const notified = new Set<string>()

function maybeNotifyCompletion(sessionID: string | undefined, type: string) {
  if (!sessionID || !prefs?.notify) return
  const key = `${sessionID}:${type}`
  if (notified.has(key)) return
  let record: { parentID?: string; agent?: string; title?: string } | undefined
  try {
    record = context?.data.session.get(sessionID)
  } catch {
    return
  }
  if (!record?.parentID) return // only subagent sessions
  notified.add(key)
  if (notified.size > 1000) {
    const oldest = notified.values().next().value
    if (oldest !== undefined) notified.delete(oldest)
  }

  const outcome: "succeeded" | "failed" | "interrupted" = type.endsWith("succeeded")
    ? "succeeded"
    : type.endsWith("failed")
      ? "failed"
      : "interrupted"
  const agent = record.agent ?? "subagent"
  const title = record.title ? ` · ${record.title}` : ""
  const line = `${STATUS_ICON[outcome]} ${agent}${title}`

  context?.ui.toast.show({ title: "Radar", message: line, sessionID })

  const attention = context?.attention
  if (!attention) return
  void attention
    .notify({
      title: "Radar",
      message: `Subagent ${outcome}: ${record.title ?? agent}`,
      notification: { when: "blurred" },
      sound: prefs.sound
        ? { name: outcome === "failed" ? "error" : "subagent_done", when: "always" }
        : false,
    })
    .catch(() => {})
}

function handleRadarArgs(input: string) {
  const ctx = context
  if (!ctx) return
  const parts = input.trim().split(/\s+/)
  const verb = parts[0]?.toLowerCase()
  const value = parts[1]?.toLowerCase()
  const apply = (key: "notify" | "sound" | "autoOpen", on: boolean) => {
    void updatePrefs?.((draft) => {
      draft[key] = on
    })
    const label = key === "autoOpen" ? "auto-open" : key
    ctx.ui.toast.show({ title: "Radar", message: `${label} ${on ? "on" : "off"}`, variant: "success" })
  }
  if (verb === "notify") return apply("notify", value !== "off")
  if (verb === "sound") return apply("sound", value !== "off")
  if (verb === "auto") return apply("autoOpen", value !== "off")
  if (verb === "status") {
    ctx.ui.toast.show({
      title: "Radar",
      message: `notify ${prefs?.notify ? "on" : "off"} · sound ${prefs?.sound ? "on" : "off"} · auto-open ${prefs?.autoOpen !== false ? "on" : "off"}`,
    })
    return
  }
  ctx.ui.toast.show({ title: "Radar", message: "usage: /radar [notify|sound|auto] [on|off] · /radar status" })
}

// ---------------------------------------------------------------------------
// Auto-open on session entry
// ---------------------------------------------------------------------------

/** Sessions already auto-opened this TUI run, so a manual close sticks. */
const autoOpened = new Set<string>()

function AutoOpen() {
  const ctx = context!
  createEffect(() => {
    const route = ctx.ui.router.current()
    if (route.type !== "session" || !route.sessionID) return
    if (prefs?.autoOpen === false) return
    const sessionID = route.sessionID
    if (autoOpened.has(sessionID)) return
    autoOpened.add(sessionID)
    // Defer until the session view has mounted its panel host.
    setTimeout(() => {
      const current = context?.ui.router.current()
      if (current?.type !== "session" || current.sessionID !== sessionID) return
      if (context?.ui.panel.current()?.name === PANEL_NAME) return
      context?.ui.panel.open(PANEL_NAME)
    }, 0)
  })
  return null
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<DisplayStatus, string> = {
  waiting: "⚠",
  running: "◉",
  idle: "○",
  stale: "◌",
  succeeded: "✓",
  failed: "✗",
  interrupted: "⏹",
  vanished: "·",
}

function statusColor(theme: any, status: DisplayStatus): any {
  const feedback = theme?.text?.feedback
  switch (status) {
    case "waiting":
      return feedback?.warning?.base ?? theme?.text?.base
    case "running":
      return feedback?.info?.base ?? theme?.text?.base
    case "idle":
    case "stale":
    case "vanished":
      return theme?.text?.faint ?? theme?.text?.muted
    case "succeeded":
      return feedback?.success?.base ?? theme?.text?.base
    case "failed":
      return feedback?.error?.base ?? theme?.text?.base
    case "interrupted":
      return feedback?.warning?.muted ?? feedback?.warning?.base ?? theme?.text?.base
    default:
      return theme?.text?.muted
  }
}

// ---------------------------------------------------------------------------
// Panel components
// ---------------------------------------------------------------------------

function RadarGate(props: { panel: PanelInput }) {
  return (
    <Show when={props.panel.name === PANEL_NAME}>
      <RadarView panel={props.panel} />
    </Show>
  )
}

function useNow(): () => number {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return now
}

function RadarView(props: { panel: PanelInput }) {
  const ctx = context!
  const now = useNow()

  // Re-attach data sync whenever the panel follows another session. The
  // `synced` flag distinguishes "still syncing" from "really empty".
  const [synced, setSynced] = createSignal(false)
  createEffect(() => {
    const sessionID = props.panel.sessionID
    setSynced(false)
    void untrack(() => reconcilePermissions(sessionID))
      .then(() => setSynced(true))
      .catch(() => setSynced(true))
  })

  // Descendant views (any depth) are recomputed only on data ticks (events),
  // never on the 1s clock — the scan walks every message of every descendant.
  const children = createMemo(() => {
    tick()
    return collectDescendants(ctx.data, props.panel.sessionID, pendingPermissions)
  })

  // Snapshot live descendants for ghost promotion and prune expired ghosts.
  // Side effects belong in an effect, not in a memo.
  createEffect(() => {
    const current = new Set(children().map((v) => v.id))
    const bucket = ghostsFor(props.panel.sessionID)
    const at = Date.now()
    for (const view of children()) bucket.set(view.id, { view, at })
    for (const [id, entry] of [...bucket]) {
      if (!current.has(id) && at - entry.at > GHOST_TTL_MS) bucket.delete(id)
    }
    if (bucket.size === 0) ghosts.delete(props.panel.sessionID)
  })

  // Descendants that disappeared from the data layer, rendered as root-level
  // ghosts (their parent may still be alive, so force them to the root).
  const ghostViews = createMemo(() => {
    tick()
    const current = new Set(children().map((v) => v.id))
    const bucket = ghosts.get(props.panel.sessionID)
    if (!bucket || bucket.size === 0) return []
    return [...bucket.values()]
      .filter((e) => !current.has(e.view.id))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_GHOSTS)
      .map((e) => ({ ...e.view, vanished: true, parentID: props.panel.sessionID }))
  })

  const [sortMode, setSortMode] = createSignal<SortMode>("status")
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set())

  const views = createMemo(() =>
    flattenTree(
      [...children(), ...ghostViews()],
      props.panel.sessionID,
      Date.now(),
      sortMode(),
      collapsed(),
    ),
  )

  const overview = createMemo(() => aggregate([...children(), ...ghostViews()], now()))

  const [selected, setSelected] = createSignal<string | undefined>(undefined)
  const [detailOpen, setDetailOpen] = createSignal(false)

  const selectedRow = createMemo(() => views().find((row) => row.view.id === selected()))
  const selectedView = createMemo(() => selectedRow()?.view)

  function move(delta: number) {
    const list = views()
    if (list.length === 0) return
    const index = Math.max(0, list.findIndex((row) => row.view.id === selected()))
    const next = Math.min(list.length - 1, Math.max(0, index + delta))
    setSelected(list[next].view.id)
  }

  function toggleDetail() {
    if (!selected()) return
    setDetailOpen((open) => !open)
  }

  function toggleFold(expand: boolean | undefined) {
    const row = selectedRow()
    if (!row || !row.hasChildren) return
    const id = row.view.id
    setCollapsed((prev) => {
      const next = new Set(prev)
      const shouldCollapse = expand === undefined ? !next.has(id) : !expand
      if (shouldCollapse) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function openSelectedInTab() {
    const view = selectedView()
    if (!view || view.vanished) return
    if (!ctx.ui.tabs.enabled()) {
      ctx.ui.toast.show({
        message: "Session tabs are disabled (enable tabs in cli.json to jump)",
        variant: "warning",
      })
      return
    }
    ctx.ui.tabs.focus(view.id)
  }

  async function interruptSelected() {
    const view = selectedView()
    if (!view || view.vanished) return
    const status = deriveStatus(view, Date.now())
    if (status !== "running" && status !== "waiting" && status !== "stale") {
      ctx.ui.toast.show({
        title: "Radar",
        message: `${view.agent} is not running (${status})`,
        variant: "warning",
      })
      return
    }
    const confirmed = await ctx.ui.dialog.confirm({
      title: "Interrupt subagent",
      message: `Interrupt ${view.agent}${view.title ? ` · ${view.title}` : ""}?`,
      label: { confirm: "Interrupt", cancel: "Cancel" },
    })
    if (!confirmed) return
    try {
      await ctx.client.session.interrupt({ sessionID: view.id })
      ctx.ui.toast.show({ title: "Radar", message: `Interrupted ${view.agent}`, variant: "success" })
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error"
      ctx.ui.toast.show({ title: "Radar", message: `Interrupt failed: ${message}`, variant: "error" })
    }
  }

  // Panel-scoped keys, active only while this panel owns input.
  ctx.keymap.layer(() => ({
    commands: [
      { id: "radar.panel.next", title: "Radar: next subagent", bind: "j", run: () => move(1) },
      { id: "radar.panel.prev", title: "Radar: previous subagent", bind: "k", run: () => move(-1) },
      { id: "radar.panel.down", bind: "down", run: () => move(1) },
      { id: "radar.panel.up", bind: "up", run: () => move(-1) },
      { id: "radar.panel.detail", title: "Radar: toggle details", bind: "enter", run: toggleDetail },
      { id: "radar.panel.openTab", title: "Radar: open in tab", bind: "o", run: openSelectedInTab },
      {
        id: "radar.panel.interrupt",
        title: "Radar: interrupt subagent",
        bind: "x",
        run: () => void interruptSelected(),
      },
      {
        id: "radar.panel.sort",
        title: "Radar: toggle sort order",
        bind: "s",
        run: () => setSortMode((m) => (m === "status" ? "recent" : "status")),
      },
      { id: "radar.panel.fold", title: "Radar: collapse subtree", bind: "h", run: () => toggleFold(true) },
      { id: "radar.panel.unfold", title: "Radar: expand subtree", bind: "l", run: () => toggleFold(false) },
      { id: "radar.panel.fullscreen", title: "Radar: fullscreen", bind: "f", run: () => props.panel.toggleFullscreen() },
      { id: "radar.panel.close", title: "Radar: close", bind: "c", run: () => props.panel.close() },
      // The host has no universal escape-to-close binding; panels register
      // their own (the built-in diff panel does the same).
      { id: "radar.panel.escape", title: "Radar: close", bind: "escape", run: () => props.panel.close() },
    ] satisfies KeymapCommand[],
  }))

  return (
    <box flexDirection="column" flexGrow={1} paddingTop={1} paddingBottom={1}>
      <OverviewBar overview={overview} theme={ctx.theme} width={props.panel.width} />
      <Show
        when={views().length > 0}
        fallback={<EmptyState theme={ctx.theme} sessionID={props.panel.sessionID} synced={synced()} />}
      >
        <box flexDirection="column" flexGrow={1}>
          <For each={views()}>
            {(row) => (
              <AgentRow
                row={row}
                now={now()}
                width={props.panel.width}
                selected={row.view.id === selected()}
                theme={ctx.theme}
              />
            )}
          </For>
        </box>
        <Show when={detailOpen() && selectedView()}>
          <DetailView view={selectedView()!} now={now()} theme={ctx.theme} width={props.panel.width} />
        </Show>
      </Show>
      <Hints theme={ctx.theme} width={props.panel.width} tabsEnabled={ctx.ui.tabs.enabled()} />
    </box>
  )
}

function OverviewBar(props: { overview: () => ReturnType<typeof aggregate>; theme: any; width: number }) {
  const hasAny = createMemo(() => props.overview().total > 0)
  const line = createMemo(() => {
    const o = props.overview()
    const counts = `${o.running} active · ${o.succeeded} done${o.failed > 0 || o.interrupted > 0 ? ` · ${o.failed} failed · ${o.interrupted} stopped` : ""}`
    const usage = `${formatTokens(o.tokensIn)}↓ ${formatTokens(o.tokensOut)}↑ · ${formatCost(o.cost)} · ${o.toolCalls} calls${o.toolErrors > 0 ? ` · ${o.toolErrors} err` : ""}`
    return { counts: `${o.total} tracked · ${counts}`, usage }
  })
  const budget = () => Math.max(12, props.width - 2)
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box flexDirection="row">
        <text fg={props.theme?.text?.action?.primary?.base ?? props.theme?.text?.base}>⦿ radar </text>
        <Show when={hasAny()}>
          <text fg={props.theme?.text?.muted}>{truncateColumns(line().counts, budget())}</text>
        </Show>
      </box>
      <Show when={hasAny()}>
        <text fg={props.theme?.text?.faint ?? props.theme?.text?.muted}>
          {"  " + truncateColumns(line().usage, budget())}
        </text>
      </Show>
    </box>
  )
}

function AgentRow(props: { row: TreeRow; now: number; width: number; selected: boolean; theme: any }) {
  const view = () => props.row.view
  const status = createMemo(() => deriveStatus(view(), props.now))
  // Card chrome: 2 border columns + 1 padding column each side + tree indent.
  const indent = () => props.row.depth * 2
  const budget = () => Math.max(16, props.width - 4 - indent())

  const borderColor = createMemo(() => {
    const theme = props.theme
    if (props.selected) return theme?.text?.action?.primary?.base ?? theme?.border?.base
    switch (status()) {
      case "running":
        return theme?.text?.feedback?.info?.base ?? theme?.border?.base
      case "waiting":
        return theme?.text?.feedback?.warning?.base ?? theme?.border?.base
      case "vanished":
        return theme?.text?.faint ?? theme?.border?.base
      default:
        return theme?.border?.base
    }
  })

  // Identity lives in the border title: "┤ ▾ ◉ explore · glm-5.3 ├──┐"
  const cardTitle = createMemo(() => {
    const v = view()
    const twisty = props.row.hasChildren ? (props.row.collapsed ? "▸ " : "▾ ") : ""
    const who = v.model ? `${v.agent} · ${shortModel(v.model)}` : v.agent
    const max = Math.max(8, budget() - 4)
    return ` ${twisty}${STATUS_ICON[status()]} ${truncateColumns(who, max)} `
  })

  const head = createMemo(() => {
    const v = view()
    const s = status()
    let main: string
    if (s === "succeeded" || s === "failed" || s === "interrupted" || s === "vanished") {
      const end = v.updated ?? v.created ?? props.now
      main = `${formatTokens(v.tokens?.input)} in · ${formatShortClock(end)}`
    } else {
      const elapsed = props.now - (v.created ?? props.now)
      main = `${formatTokens(v.tokens?.input)}→${formatTokens(v.tokens?.output)} · ${formatDuration(elapsed)}`
    }
    const tools = v.toolErrors > 0 ? ` · ${v.toolCalls}✓ ${v.toolErrors}✗` : v.toolCalls > 0 ? ` · ${v.toolCalls}✓` : ""
    return truncateColumns(`${main}${tools}`, budget())
  })

  const title = createMemo(() => {
    const text = view().title || "(untitled)"
    return truncateColumns(text, budget())
  })

  const action = createMemo(() => {
    const tool = view().lastTool
    if (!tool) return undefined
    const icon = tool.state === "error" ? "✗" : tool.state === "completed" ? "·" : "→"
    const label = tool.summary ? `${tool.name} ${tool.summary}` : tool.name
    const wait = status() === "waiting" ? `  ⏸ ${view().waitingActions.join(", ")}` : ""
    return truncateColumns(`${icon} ${label}${wait}`, budget())
  })

  return (
    <box
      flexDirection="column"
      border={true}
      borderStyle="rounded"
      borderColor={borderColor()}
      title={cardTitle()}
      titleColor={statusColor(props.theme, status())}
      titleAlignment="left"
      paddingX={1}
      marginLeft={indent()}
      marginBottom={1}
    >
      <text fg={statusColor(props.theme, status())}>{head()}</text>
      <text fg={props.selected ? props.theme?.text?.base : props.theme?.text?.muted}>{title()}</text>
      <Show when={action()}>
        <text fg={props.theme?.text?.faint ?? props.theme?.text?.muted}>{action() ?? ""}</text>
      </Show>
    </box>
  )
}

function DetailView(props: { view: AgentView; now: number; theme: any; width: number }) {
  const rows = createMemo(() => {
    const budget = Math.max(20, props.width - 2)
    const v = props.view
    const t = v.tokens
    const span =
      v.created !== undefined
        ? `${formatShortClock(v.created)} → ${formatShortClock(v.updated ?? props.now)} · ${formatDuration((v.updated ?? props.now) - v.created)}`
        : "unknown"
    const statusText =
      STATUS_ICON[deriveStatus(v, props.now)] + " " + deriveStatus(v, props.now) +
      (v.waiting ? ` · waiting for permission (${v.waitingActions.join(", ")})` : "")
    const lines = [
      `agent    ${v.agent}${v.model ? ` · ${v.model}` : ""}`,
      `status   ${statusText}`,
      `tokens   ${t ? `in ${formatTokens(t.input)} · out ${formatTokens(t.output)} · reasoning ${formatTokens(t.reasoning)}` : "none"}`,
      t ? `         cache read ${formatTokens(t.cacheRead)} · write ${formatTokens(t.cacheWrite)}` : "",
      `cost     ${formatCost(v.cost)}`,
      `tools    ${v.toolCalls} calls${v.toolErrors > 0 ? ` · ${v.toolErrors} failed` : ""}`,
      v.lastTool
        ? `last     ${v.lastTool.name} · ${formatDuration(Math.max(0, props.now - v.lastTool.at))} ago${v.lastTool.summary ? ` · ${v.lastTool.summary}` : ""}`
        : "",
      `span     ${span}`,
      `session  ${v.id}`,
    ]
    return lines.filter((l) => l.length > 0).map((l) => truncateColumns(l, budget))
  })
  const separator = createMemo(() => "─".repeat(Math.max(0, Math.min(60, props.width - 2))))
  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1}>
      <text fg={props.theme?.text?.faint ?? props.theme?.text?.muted}>{separator()}</text>
      <For each={rows()}>
        {(row) => <text fg={props.theme?.text?.muted}>{row}</text>}
      </For>
    </box>
  )
}

function EmptyState(props: { theme: any; sessionID: string; synced: boolean }) {
  const faint = () => props.theme?.text?.faint ?? props.theme?.text?.muted
  return (
    <box flexDirection="column" flexGrow={1} paddingTop={2}>
      <text fg={faint()}>⦿</text>
      <Show when={props.synced} fallback={<text fg={props.theme?.text?.muted}>Syncing session…</text>}>
        <text fg={props.theme?.text?.muted}>No subagents yet</text>
        <text fg={faint()}>Subagents spawned by this session appear here with live</text>
        <text fg={faint()}>tokens, tools, and status.</text>
      </Show>
    </box>
  )
}

function Hints(props: { theme: any; width: number; tabsEnabled: boolean }) {
  const hints = createMemo(() => {
    const parts = ["j/k select", "enter details", "h/l fold", "x interrupt", "s sort"]
    if (props.tabsEnabled) parts.push("o tab")
    parts.push("f fullscreen", "esc close", "ctrl+x ← prompt")
    return parts.join(" · ")
  })
  return (
    <box flexDirection="column">
      <text fg={props.theme?.text?.faint ?? props.theme?.text?.muted}>{truncateColumns(hints(), props.width)}</text>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "radar",
  setup(tuiContext) {
    context = tuiContext as TuiContext

    const stopEvents = context.data.listen(({ details }) => {
      const sessionID = details.data?.sessionID
      switch (details.type) {
        case "permission.asked":
          trackPermissionAsked(sessionID, details.data?.id, details.data?.action)
          break
        case "permission.replied":
          trackPermissionResolved(sessionID, details.data?.requestID)
          break
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          maybeNotifyCompletion(sessionID, details.type)
          break
        default:
          break
      }
      scheduleRefresh()
    })

    // Persisted preferences, live-synced across TUI instances.
    const [storedPrefs, setPrefs] = context.storage.store<RadarPrefs>("radar.prefs", {
      initial: { notify: true, sound: false },
    })
    prefs = storedPrefs
    updatePrefs = setPrefs

    // /radar [args] + palette entry
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "radar.open",
          title: "Radar: subagent monitor",
          group: "Radar",
          palette: true,
          slash: { name: "radar", arguments: true },
          run: (input?: string) => {
            const arg = (input ?? "").trim()
            if (arg) {
              handleRadarArgs(arg)
              return
            }
            const opened = context!.ui.panel.open(PANEL_NAME)
            if (!opened) {
              context!.ui.toast.show({
                message: "Radar follows a session — open a session first",
                variant: "warning",
              })
            }
          },
        } satisfies KeymapCommand,
      ],
    }))

    const releasePanel = context.ui.slot({
      append: "session.panel",
      render: (panel: PanelInput) => <RadarGate panel={panel} />,
    })

    const releaseAutoOpen = context.ui.slot({
      append: "app",
      render: () => <AutoOpen />,
    })

    return () => {
      stopEvents?.()
      releasePanel?.()
      releaseAutoOpen?.()
      pendingPermissions.clear()
      ghosts.clear()
      notified.clear()
      prefs = undefined
      updatePrefs = undefined
      reconcileGeneration++
      context = undefined
    }
  },
})
