// Pure logic for the contextbar: reference-message selection (official
// context-usage formula), usage sums, config parsing, and bar layout.

export interface TokenUsageLike {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export interface MessageLike {
  id?: string
  type?: string
  status?: string
  tokens?: TokenUsageLike
}

/** input + output + reasoning + cache.read + cache.write — the official total. */
export function usageTotal(t: TokenUsageLike | undefined): number {
  if (!t) return 0
  return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
}

/**
 * The assistant step whose tokens fill the context window now: the latest one
 * after the last completed compaction and before the revert boundary.
 */
export function pickReference(messages: MessageLike[], revertID?: string): MessageLike | undefined {
  let end = messages.length
  if (revertID) {
    const index = messages.findIndex((m) => m?.id === revertID)
    if (index >= 0) end = index
  }
  let after = 0
  for (let i = 0; i < end; i++) {
    const m = messages[i]
    if (m?.type === "compaction" && m.status === "completed") after = i + 1
  }
  for (let i = end - 1; i >= after; i--) {
    const m = messages[i]
    if (m?.type === "assistant" && m.tokens && usageTotal(m.tokens) > 0) return m
  }
  return undefined
}

export interface ConfigEntryLike {
  type?: string
  info?: { compaction?: { buffer?: number } }
}

/** Last config document that defines compaction.buffer wins (shallow merge). */
export function extractBuffer(entries: ConfigEntryLike[] | undefined): number | undefined {
  let buffer: number | undefined
  for (const entry of entries ?? []) {
    const value = entry?.info?.compaction?.buffer
    if (typeof value === "number" && value >= 0) buffer = value
  }
  return buffer
}

export const CHARS_PER_TOKEN = 4

/** OpenCode's own calibration (binary: round(chars / 4)). */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / CHARS_PER_TOKEN))
}

// ---------------------------------------------------------------------------
// Bar plan
// ---------------------------------------------------------------------------

export type SegmentKey = "system" | "tools" | "memory" | "skills" | "messages"

export interface Segment {
  key: SegmentKey
  /** display label */
  label: string
  /** token count; undefined = no data (segment omitted) */
  tokens: number | undefined
  /** estimate rather than provider-exact */
  approx: boolean
}

export interface BarPlan {
  segments: Segment[]
  used: number
  /**
   * True when `used` is the provider-exact total (the same number the
   * built-in usage display shows). False = fallback sum of estimates only.
   */
  exact: boolean
  limit: number | undefined
  buffer: number
  free: number
}

/**
 * Segments PARTITION the provider-exact total context usage. The total is the
 * last assistant message's five-field token sum — which already includes the
 * system prompt, tools, and instructions, because every request re-sends the
 * full prompt. The chars/4 estimates carve the static parts out of that
 * total; the remainder is the conversation proper. Adding estimates on top of
 * the total (instead of partitioning) double-counts them.
 */
export function planBar(input: {
  systemTokens?: number
  toolsTokens?: number
  memoryTokens?: number
  skillsTokens?: number
  /** provider-exact total context usage (last assistant five-field sum) */
  totalTokens?: number
  limit?: number
  buffer?: number
}): BarPlan {
  const statics: Segment[] = (
    [
      { key: "system", label: "system prompt", tokens: input.systemTokens },
      { key: "tools", label: "system tools", tokens: input.toolsTokens },
      { key: "memory", label: "memory files", tokens: input.memoryTokens },
      { key: "skills", label: "skills", tokens: input.skillsTokens },
    ] as Array<{ key: SegmentKey; label: string; tokens?: number }>
  )
    .filter((s) => s.tokens !== undefined && s.tokens > 0)
    .map((s) => ({ ...s, approx: true, tokens: s.tokens as number }))

  const estimateSum = statics.reduce((sum, s) => sum + (s.tokens ?? 0), 0)
  const limit = input.limit && input.limit > 0 ? input.limit : undefined
  const buffer = Math.max(0, input.buffer ?? 0)

  if (input.totalTokens !== undefined && input.totalTokens > 0) {
    const total = input.totalTokens
    let segments = statics
    let carved = estimateSum
    // Estimation overshoot: scale the static parts down so they still fit.
    if (carved > total) {
      const scale = total / carved
      segments = statics.map((s) => ({ ...s, tokens: Math.max(0, Math.round((s.tokens ?? 0) * scale)) }))
      carved = segments.reduce((sum, s) => sum + (s.tokens ?? 0), 0)
    }
    const remainder = total - carved
    if (remainder > 0) {
      segments = [...segments, { key: "messages", label: "messages", tokens: remainder, approx: false }]
    }
    const used = total
    return { segments, used, exact: true, limit, buffer, free: limit === undefined ? 0 : Math.max(0, limit - used - buffer) }
  }

  // Fallback without a provider total: estimates only (rare — both the hook
  // measurement and usage arrive after the first model call).
  return { segments: statics, used: estimateSum, exact: false, limit, buffer, free: limit === undefined ? 0 : Math.max(0, limit - estimateSum - buffer) }
}

export type BarKind = "segment" | "buffer" | "free"

export interface BarPart {
  kind: BarKind
  /** index into theme.categorical for segments; free/buffer use text tones */
  colorIndex: number
  cols: number
}

/**
 * Distribute `width` columns across segments, the buffer zone, and free space.
 * Non-zero segments get at least one column when width allows; when the bar is
 * too narrow to fit every part, the largest weights win one column each.
 */
export function layoutBar(plan: BarPlan, width: number): BarPart[] {
  if (width <= 0) return []
  const total = plan.used + plan.buffer + plan.free
  if (total <= 0) return [{ kind: "free", colorIndex: 0, cols: width }]

  interface Candidate {
    kind: BarKind
    colorIndex: number
    weight: number
  }
  const candidates: Candidate[] = []
  plan.segments.forEach((segment, index) => {
    if ((segment.tokens ?? 0) > 0) {
      candidates.push({ kind: "segment", colorIndex: index, weight: segment.tokens ?? 0 })
    }
  })
  if (plan.buffer > 0) candidates.push({ kind: "buffer", colorIndex: 0, weight: plan.buffer })

  // Too many parts for the width: keep the largest weights, one column each.
  if (candidates.length > width) {
    return [...candidates]
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => b.candidate.weight - a.candidate.weight || a.index - b.index)
      .slice(0, width)
      .sort((a, b) => a.index - b.index)
      .map((entry) => ({ kind: entry.candidate.kind, colorIndex: entry.candidate.colorIndex, cols: 1 }))
  }

  const parts: BarPart[] = []
  let assigned = 0
  for (const candidate of candidates) {
    const proportional = Math.floor((candidate.weight / total) * width)
    const cols = Math.max(1, proportional)
    parts.push({ kind: candidate.kind, colorIndex: candidate.colorIndex, cols })
    assigned += cols
  }
  if (plan.free > 0 && assigned < width) {
    parts.push({ kind: "free", colorIndex: 0, cols: width - assigned })
    assigned = width
  }
  if (assigned > width) {
    // trim from the widest part (never below one column) until it fits
    let excess = assigned - width
    while (excess > 0) {
      let biggest = -1
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].cols > 1 && (biggest === -1 || parts[i].cols > parts[biggest].cols)) biggest = i
      }
      if (biggest === -1) break
      parts[biggest].cols--
      excess--
    }
  }
  return parts.filter((part) => part.cols > 0)
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return "0"
  const v = Math.round(tokens)
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`
  return String(v)
}

export function formatPercent(tokens: number, limit: number | undefined): string {
  if (limit === undefined || limit <= 0) return ""
  const pct = (tokens / limit) * 100
  if (pct <= 0) return "0%"
  if (pct < 0.1) return "<0.1%"
  if (pct < 1) return `${pct.toFixed(1)}%`
  return `${Math.round(pct)}%`
}
