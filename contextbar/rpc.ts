// Shared RPC contract between the contextbar server plugin (measurement
// producer) and the TUI plugin (consumer).
//
// Transport note: RPC method calls are location-scoped (a request without an
// explicit location falls back to the server's cwd, where project plugins are
// not loaded — see anomalyco/opencode#58438). RPC events broadcast across
// locations as `rpc.<id>.<event>`, which suits this consumer — so the contract
// is events-only. `snapshot` (heartbeat) covers TUI restarts; events are
// live-only, so the TUI cannot replay them itself.

import { Rpc } from "@opencode/plugin/rpc"

export interface Measurement {
  sessionID: string
  /** chars of system[0] — the agent system prompt */
  systemChars: number
  /** chars of system[1..] — merged instructions (memory files, skills, MCP, …) */
  instructionsChars: number
  /** chars of name + description + JSON schema over all tools */
  toolsChars: number
  toolCount: number
  providerID: string
  modelID: string
  /** epoch ms of the measured model call */
  at: number
}

const measurementProperties = {
  sessionID: { type: "string" },
  systemChars: { type: "number" },
  instructionsChars: { type: "number" },
  toolsChars: { type: "number" },
  toolCount: { type: "number" },
  providerID: { type: "string" },
  modelID: { type: "string" },
  at: { type: "number" },
}

const measurementRequired = [
  "sessionID",
  "systemChars",
  "instructionsChars",
  "toolsChars",
  "toolCount",
  "providerID",
  "modelID",
  "at",
]

export const ContextbarRpc = Rpc.define({
  id: "contextbar",
  methods: {},
  events: {
    /** Emitted after every measured model request. */
    measured: {
      schema: {
        type: "object",
        properties: measurementProperties,
        required: measurementRequired,
        additionalProperties: false,
      },
    },
    /** Heartbeat with every cached measurement, for late-joining clients. */
    snapshot: {
      schema: {
        type: "object",
        properties: {
          measurements: {
            type: "array",
            items: {
              type: "object",
              properties: measurementProperties,
              required: measurementRequired,
              additionalProperties: false,
            },
          },
        },
        required: ["measurements"],
        additionalProperties: false,
      },
    },
  },
})
