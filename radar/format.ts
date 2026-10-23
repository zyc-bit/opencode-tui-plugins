// Formatting + terminal-column helpers for the radar panel.
// All display strings are measured in terminal columns (CJK-aware), not chars.

const ELLIPSIS = "…"
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0xfeff])

function isCombining(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  )
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

function charWidth(cp: number): 0 | 1 | 2 {
  if (cp === 0 || cp < 32 || (cp >= 127 && cp < 160)) return 0
  if (ZERO_WIDTH.has(cp) || isCombining(cp)) return 0
  return isWide(cp) ? 2 : 1
}

export function textColumns(value: string): number {
  let columns = 0
  for (const ch of value) columns += charWidth(ch.codePointAt(0) ?? 0)
  return columns
}

export function truncateColumns(value: string, maxColumns: number): string {
  if (maxColumns <= 0) return ""
  if (textColumns(value) <= maxColumns) return value
  let columns = 0
  let out = ""
  for (const ch of value) {
    const w = charWidth(ch.codePointAt(0) ?? 0)
    if (columns + w > maxColumns - 1) break
    columns += w
    out += ch
  }
  return out.trimEnd() + ELLIPSIS
}

export function padColumns(value: string, width: number): string {
  const diff = width - textColumns(value)
  return diff > 0 ? value + " ".repeat(diff) : value
}

/** 1234 -> "1.2k", 1234567 -> "1.2M" */
export function formatCount(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "0"
  const v = Math.max(0, Math.round(n))
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`
  return String(v)
}

/** tokens formatted with a suffix, e.g. "12.3k" */
export function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return "0"
  return formatCount(n)
}

/** MoneyUSD is a plain number of US dollars. */
export function formatCost(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return "$0"
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 1) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(3)}`
}

/** elapsed ms -> "3m12s" / "1h04m" / "12s" */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`
  return `${s}s`
}

/** epoch ms -> local "HH:MM:SS" */
export function formatClock(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return "--:--:--"
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** epoch ms -> local "HH:MM" */
export function formatShortClock(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return "--:--"
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Truncates a long model id to keep row columns stable; ids carry no provider prefix. */
export function shortModel(modelID: string | undefined): string {
  if (!modelID) return ""
  return modelID.length > 28 ? modelID.slice(0, 27) + ELLIPSIS : modelID
}

export function relativeTime(ts: number | undefined, now: number): string {
  if (ts === undefined || !Number.isFinite(ts)) return ""
  return formatDuration(now - ts) + " ago"
}
