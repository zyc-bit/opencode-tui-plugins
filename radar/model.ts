// Reads subagent (child-session) state from the OpenCode TUI data layer and
// derives display-ready views. Pure reads; no subscriptions here.

export type DisplayStatus =
  | "waiting" // running and a permission request is pending
  | "running"
  | "idle" // no outcome, not executing, recently updated
  | "stale" // no outcome, no activity for 10 minutes
  | "succeeded"
  | "failed"
  | "interrupted"
  | "vanished" // session deleted while we knew about it

export interface ToolAction {
  name: string
  summary: string
  state: "streaming" | "running" | "completed" | "error"
  at: number
}

export interface AgentView {
  id: string
  parentID: string
  agent: string
  model: string
  title: string
  created: number | undefined
  updated: number | undefined
  live: "idle" | "running"
  outcome: "succeeded" | "failed" | "interrupted" | undefined
  waiting: boolean
  waitingActions: string[]
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number } | undefined
  cost: number
  toolCalls: number
  toolErrors: number
  lastTool: ToolAction | undefined
  vanished: boolean
}

export interface Overview {
  total: number
  running: number
  waiting: number
  succeeded: number
  failed: number
  interrupted: number
  tokensIn: number
  tokensOut: number
  cost: number
  toolCalls: number
  toolErrors: number
  wallMs: number
}

// Minimal structural type for the parts of the TUI plugin context we use.
// Kept local so the runtime never needs to resolve type-only packages.
export interface RadarData {
  session: {
    family(sessionID: string): string[]
    get(sessionID: string): SessionRecord | undefined
    status(sessionID: string): "idle" | "running"
    message: {
      list(sessionID: string): unknown[]
    }
    permission: {
      list(sessionID: string): Array<{ id?: string; action?: string }> | undefined
    }
  }
}

export interface SessionRecord {
  id: string
  parentID?: string
  agent?: string
  model?: { id?: string }
  title?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  outcome?: "succeeded" | "failed" | "interrupted"
  time?: { created?: number; updated?: number; idle?: number }
}

export const STALE_MS = 10 * 60_000

export const STATUS_ORDER: Record<DisplayStatus, number> = {
  waiting: 0,
  running: 1,
  idle: 2,
  stale: 3,
  failed: 4,
  interrupted: 5,
  succeeded: 6,
  vanished: 7,
}

export type SortMode = "status" | "recent"

// ---------------------------------------------------------------------------
// Message scanning
// ---------------------------------------------------------------------------

interface ToolPart {
  type: "tool"
  id: string
  name: string
  state: { status: ToolAction["state"]; input?: unknown }
  time?: { created?: number; ran?: number; completed?: number }
}

const SUMMARY_KEYS = [
  "path",
  "file_path",
  "file",
  "command",
  "cmd",
  "pattern",
  "query",
  "url",
  "agent",
  "description",
  "skill",
  "id",
  "name",
]

function summarizeInput(input: unknown): string {
  let obj: unknown = input
  if (typeof input === "string") {
    // streaming tool input arrives as a partial JSON string
    if (input.trimStart().startsWith("{") || input.trimStart().startsWith("[")) {
      try {
        obj = JSON.parse(input)
      } catch {
        return input.length > 60 ? input.slice(0, 57) + "…" : input
      }
    } else {
      return input.length > 60 ? input.slice(0, 57) + "…" : input
    }
  }
  if (!obj || typeof obj !== "object") return ""
  const record = obj as Record<string, unknown>
  for (const key of SUMMARY_KEYS) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) {
      return value.length > 60 ? value.slice(0, 57) + "…" : value
    }
  }
  if (typeof record.command === "object" && Array.isArray((record.command as { argv?: unknown[] }).argv)) {
    const argv = (record.command as { argv: string[] }).argv
    const joined = argv.join(" ")
    return joined.length > 60 ? joined.slice(0, 57) + "…" : joined
  }
  return ""
}

export function scanTools(messages: unknown[]): { calls: number; errors: number; last?: ToolAction } {
  let calls = 0
  let errors = 0
  let lastPart: ToolPart | undefined
  for (const message of messages) {
    const content = (message as { content?: unknown[] }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || (part as { type?: string }).type !== "tool") continue
      const tool = part as ToolPart
      calls++
      if ((tool.state?.status ?? "running") === "error") errors++
      lastPart = tool
    }
  }
  if (!lastPart) return { calls, errors }
  // Summarize only the final tool part — the one the panel displays.
  return {
    calls,
    errors,
    last: {
      name: lastPart.name ?? lastPart.id ?? "tool",
      summary: summarizeInput(lastPart.state?.input),
      state: lastPart.state?.status ?? "running",
      at: lastPart.time?.ran ?? lastPart.time?.completed ?? lastPart.time?.created ?? 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Per-session scan cache (v2.7)
// ---------------------------------------------------------------------------

type ScanResult = { calls: number; errors: number; last?: ToolAction }

interface ScanCacheEntry {
  fingerprint: string
  result: ScanResult
}

/** sessionID -> cached scan, module lifetime, bounded. */
const scanCache = new Map<string, ScanCacheEntry>()

function inputLength(input: unknown): number {
  return typeof input === "string" ? input.length : 0
}

/**
 * Cheap change detector over the message list shape: total length plus the
 * last content-bearing message's id, part count, and a (name, state,
 * input-size) signature of its trailing tool parts. In-place edits to
 * mid-history messages are not detected — tool parts only change on the
 * executing (last) message in practice.
 */
function fingerprint(messages: unknown[]): string {
  let last: { id?: string; content?: unknown[] } | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = (messages[i] as { content?: unknown[] }).content
    if (Array.isArray(content)) {
      last = messages[i] as { id?: string; content?: unknown[] }
      break
    }
  }
  const parts = last?.content ?? []
  let sig = `${messages.length}:${last?.id ?? ""}:${parts.length}`
  for (const part of parts.slice(-6)) {
    const tool = part as ToolPart
    if (!tool || tool.type !== "tool") continue
    sig += `|${tool.name ?? ""}:${tool.state?.status ?? ""}:${inputLength(tool.state?.input)}`
  }
  return sig
}

/** scanTools with a per-session fingerprint cache: unchanged sessions skip the rescan. */
export function scanToolsCached(sessionID: string, messages: unknown[]): ScanResult {
  const fp = fingerprint(messages)
  const cached = scanCache.get(sessionID)
  if (cached && cached.fingerprint === fp) return cached.result
  const result = scanTools(messages)
  if (scanCache.size >= 64) {
    const oldest = scanCache.keys().next().value
    if (oldest !== undefined) scanCache.delete(oldest)
  }
  scanCache.set(sessionID, { fingerprint: fp, result })
  return result
}

// ---------------------------------------------------------------------------
// View assembly
// ---------------------------------------------------------------------------

export function toView(data: RadarData, record: SessionRecord, waitingActions: string[]): AgentView {
  const messages = safeList(data, record.id)
  const tools = scanToolsCached(record.id, messages)
  const live = safeStatus(data, record.id)
  return {
    id: record.id,
    parentID: record.parentID ?? "",
    agent: record.agent ?? "agent",
    model: record.model?.id ?? "",
    title: record.title ?? "",
    created: record.time?.created,
    updated: record.time?.updated,
    live,
    outcome: record.outcome,
    waiting: waitingActions.length > 0,
    waitingActions,
    tokens: record.tokens
      ? {
          input: record.tokens.input ?? 0,
          output: record.tokens.output ?? 0,
          reasoning: record.tokens.reasoning ?? 0,
          cacheRead: record.tokens.cache?.read ?? 0,
          cacheWrite: record.tokens.cache?.write ?? 0,
        }
      : undefined,
    cost: record.cost ?? 0,
    toolCalls: tools.calls,
    toolErrors: tools.errors,
    lastTool: tools.last,
    vanished: false,
  }
}

function safeList(data: RadarData, sessionID: string): unknown[] {
  try {
    return data.session.message.list(sessionID) ?? []
  } catch {
    return []
  }
}

function safeStatus(data: RadarData, sessionID: string): "idle" | "running" {
  try {
    const status = data.session.status(sessionID)
    return status === "running" ? "running" : "idle"
  } catch {
    return "idle"
  }
}

/**
 * Direct child sessions of `sessionID`, as display views, sorted with the
 * most interesting rows first.
 */
export function collectChildren(
  data: RadarData,
  sessionID: string,
  pendingPermissions: Map<string, Map<string, string>>,
): AgentView[] {
  let ids: string[] = []
  try {
    ids = data.session.family(sessionID) ?? []
  } catch {
    ids = []
  }
  const views: AgentView[] = []
  for (const id of ids) {
    let record: SessionRecord | undefined
    try {
      record = data.session.get(id)
    } catch {
      record = undefined
    }
    if (!record || record.parentID !== sessionID) continue
    const waiting = [...(pendingPermissions.get(id)?.values() ?? [])]
    views.push(toView(data, record, waiting))
  }
  return views
}

// ---------------------------------------------------------------------------
// Tree assembly (v2.2): descendants, folding, flattening
// ---------------------------------------------------------------------------

export interface TreeRow {
  view: AgentView
  depth: number
  hasChildren: boolean
  collapsed: boolean
}

/**
 * All descendant sessions of `sessionID` at any depth, as views. Descendants
 * whose parent vanished from the data layer are re-attached at the root so
 * running grandchildren never disappear.
 */
export function collectDescendants(
  data: RadarData,
  sessionID: string,
  pendingPermissions: Map<string, Map<string, string>>,
): AgentView[] {
  let ids: string[] = []
  try {
    ids = data.session.family(sessionID) ?? []
  } catch {
    return []
  }
  const byParent = new Map<string, AgentView[]>()
  for (const id of ids) {
    if (id === sessionID) continue
    let record: SessionRecord | undefined
    try {
      record = data.session.get(id)
    } catch {
      record = undefined
    }
    if (!record?.parentID) continue
    const waiting = [...(pendingPermissions.get(id)?.values() ?? [])]
    const view = toView(data, record, waiting)
    const siblings = byParent.get(record.parentID) ?? []
    siblings.push(view)
    byParent.set(record.parentID, siblings)
  }
  const out: AgentView[] = []
  const walk = (parentID: string) => {
    for (const child of byParent.get(parentID) ?? []) {
      out.push(child)
      walk(child.id)
    }
  }
  walk(sessionID)
  // Orphan groups (parent id no longer present) surface at the root.
  const inTree = new Set(out.map((v) => v.id))
  inTree.add(sessionID)
  for (const [parentID, children] of byParent) {
    if (parentID === sessionID || inTree.has(parentID)) continue
    for (const child of children) {
      out.push(child)
      walk(child.id)
    }
  }
  return out
}

/**
 * Flatten the descendant tree into visible rows: siblings sorted by `mode`,
 * subtrees of collapsed parents hidden.
 */
export function flattenTree(
  all: AgentView[],
  rootID: string,
  now: number,
  mode: SortMode,
  collapsed: ReadonlySet<string>,
): TreeRow[] {
  const childrenOf = new Map<string, AgentView[]>()
  for (const view of all) {
    const list = childrenOf.get(view.parentID) ?? []
    list.push(view)
    childrenOf.set(view.parentID, list)
  }
  for (const list of childrenOf.values()) {
    const sorted = sortViews(list, now, mode)
    list.length = 0
    list.push(...sorted)
  }
  const rows: TreeRow[] = []
  const visit = (parentID: string, depth: number) => {
    for (const view of childrenOf.get(parentID) ?? []) {
      const isCollapsed = collapsed.has(view.id)
      rows.push({ view, depth, hasChildren: childrenOf.has(view.id), collapsed: isCollapsed })
      if (!isCollapsed) visit(view.id, depth + 1)
    }
  }
  visit(rootID, 0)
  return rows
}

export function deriveStatus(view: AgentView, now: number): DisplayStatus {
  if (view.vanished) return "vanished"
  if (view.outcome === "succeeded") return "succeeded"
  if (view.outcome === "failed") return "failed"
  if (view.outcome === "interrupted") return "interrupted"
  if (view.live === "running") return view.waiting ? "waiting" : "running"
  // idle without outcome: mark stale when it has been quiet for a long time
  const updated = view.updated ?? view.created ?? 0
  if (updated > 0 && now - updated > STALE_MS) return "stale"
  return "idle"
}

export function sortViews(views: AgentView[], now: number, mode: SortMode = "status"): AgentView[] {
  return [...views].sort((a, b) => {
    if (mode === "recent") {
      return (b.updated ?? b.created ?? 0) - (a.updated ?? a.created ?? 0)
    }
    const order = STATUS_ORDER[deriveStatus(a, now)] - STATUS_ORDER[deriveStatus(b, now)]
    if (order !== 0) return order
    return (b.updated ?? b.created ?? 0) - (a.updated ?? a.created ?? 0)
  })
}

export function aggregate(views: AgentView[], now: number): Overview {
  const overview: Overview = {
    total: views.length,
    running: 0,
    waiting: 0,
    succeeded: 0,
    failed: 0,
    interrupted: 0,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    toolCalls: 0,
    toolErrors: 0,
    wallMs: 0,
  }
  let minCreated = Number.POSITIVE_INFINITY
  let maxUpdated = 0
  for (const view of views) {
    switch (deriveStatus(view, now)) {
      case "waiting":
        overview.waiting++
        overview.running++
        break
      case "running":
        overview.running++
        break
      // idle and stale are neither active nor finished; not counted
      case "succeeded":
        overview.succeeded++
        break
      case "failed":
        overview.failed++
        break
      case "interrupted":
        overview.interrupted++
        break
      default:
        break
    }
    overview.tokensIn += view.tokens?.input ?? 0
    overview.tokensOut += view.tokens?.output ?? 0
    overview.cost += view.cost ?? 0
    overview.toolCalls += view.toolCalls
    overview.toolErrors += view.toolErrors
    if (view.created && view.created < minCreated) minCreated = view.created
    const end = Math.max(view.updated ?? 0, view.created ?? 0)
    if (end > maxUpdated) maxUpdated = end
  }
  if (views.length > 0 && minCreated !== Number.POSITIVE_INFINITY) {
    const active = views.some((v) => {
      const s = deriveStatus(v, now)
      return s === "running" || s === "waiting"
    })
    overview.wallMs = (active ? now : maxUpdated) - minCreated
  }
  return overview
}
