import { strict as assert } from "node:assert"
import { test } from "node:test"
import { estimateTokens, mergeMeasurements, planBar } from "../core.ts"
import type { Measurement } from "../rpc.ts"

function measurement(sessionID: string, at = 1_000): Measurement {
  return {
    sessionID,
    systemChars: 2_825,
    instructionsChars: 22_334,
    toolsChars: 11_832,
    toolCount: 10,
    providerID: "provider",
    modelID: "model",
    at,
  }
}

test("alternating location snapshots preserve the current session's full bar", () => {
  const current = measurement("current-session")
  const other = measurement("other-project-session", 2_000)
  let cache = new Map<string, Measurement>()
  const snapshots = [[current], [other], [current], [other], [current]]
  const plans = []

  for (const snapshot of snapshots) {
    cache = mergeMeasurements(cache, snapshot)
    const m = cache.get(current.sessionID)
    assert.equal(m, current, "another location must not clear the current measurement")
    const skillsTokens = 3_100
    const plan = planBar({
      systemTokens: estimateTokens(m.systemChars),
      toolsTokens: estimateTokens(m.toolsChars),
      memoryTokens: Math.max(0, estimateTokens(m.instructionsChars) - skillsTokens),
      skillsTokens,
      totalTokens: 26_000,
      limit: 922_000,
      buffer: 32_000,
    })
    assert.deepEqual(plan.segments.map((s) => s.key), ["system", "tools", "memory", "skills", "messages"])
    assert.equal(plan.used, 26_000)
    assert.equal(plan.free, 864_000)
    assert.equal(plan.exact, true)
    plans.push(plan)
    assert.deepEqual(plan, plans[0], "segment sizes must not oscillate between snapshots")
  }
  assert.equal(cache.get(other.sessionID), other)
})

test("merging a snapshot never mutates the previous cache", () => {
  const current = measurement("current-session")
  const other = measurement("other-project-session")
  const previous = new Map([[current.sessionID, current]])
  const merged = mergeMeasurements(previous, [other])

  assert.notEqual(merged, previous)
  assert.equal(previous.size, 1)
  assert.equal(previous.has(other.sessionID), false)
  assert.equal(merged.get(current.sessionID), current)
  assert.equal(merged.get(other.sessionID), other)
})

test("an older snapshot cannot overwrite a newer measured event", () => {
  const old = measurement("current-session")
  const latest = { ...old, at: 3_000, systemChars: 4_000 }
  let cache = mergeMeasurements(new Map(), [old])
  cache = mergeMeasurements(cache, [latest])

  const merged = mergeMeasurements(cache, [old])
  assert.equal(merged, cache)
  assert.equal(merged.get(old.sessionID), latest)
})

test("a newer measurement updates only its own session", () => {
  const current = measurement("current-session")
  const other = measurement("other-project-session", 5_000)
  const previous = new Map([[current.sessionID, current], [other.sessionID, other]])
  const latest = { ...current, at: 2_000, toolsChars: 16_000 }
  const merged = mergeMeasurements(previous, [latest])

  assert.equal(merged.get(current.sessionID), latest)
  assert.equal(merged.get(other.sessionID), other)
  assert.equal(previous.get(current.sessionID), current)
})

test("empty and duplicate heartbeats retain the cache identity", () => {
  const current = measurement("current-session")
  const previous = new Map([[current.sessionID, current]])

  assert.equal(mergeMeasurements(previous, []), previous)
  assert.equal(mergeMeasurements(previous, [{ ...current }]), previous)
})

test("out-of-order entries in one snapshot keep the newest measurement", () => {
  const old = measurement("current-session")
  const latest = { ...old, at: 3_000, instructionsChars: 30_000 }
  const middle = { ...old, at: 2_000 }
  const merged = mergeMeasurements(new Map(), [latest, old, middle])

  assert.equal(merged.size, 1)
  assert.equal(merged.get(old.sessionID), latest)
})

test("invalid session IDs and timestamps do not disturb cached measurements", () => {
  const current = measurement("current-session")
  const previous = new Map([[current.sessionID, current]])
  const merged = mergeMeasurements(previous, [
    measurement(""),
    { ...current, at: Number.NaN },
    { ...current, at: Number.POSITIVE_INFINITY },
  ])

  assert.equal(merged, previous)
})
