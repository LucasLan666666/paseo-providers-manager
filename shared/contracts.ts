import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const agentIds = [
  "claude",
  "codex",
  "copilot",
  "opencode",
  "pi",
  "omp",
  "antigravity",
  "muse",
  "fx",
  "hoplite",
] as const;
export const protocols = ["chat", "responses", "anthropic", "gemini"] as const;
const agent = z.enum(agentIds);
const protocol = z.enum(protocols);
export type AgentId = z.infer<typeof agent>;
export type Protocol = z.infer<typeof protocol>;
const id = z.string().min(1).max(2048);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const capacity = z.object({
  value: positive,
  source: z.enum(["gateway", "catalog"]),
});
const override = z.object({ value: positive, ack: positive.optional() });
const limits = z.object({
  context: positive.optional(),
  output: positive.optional(),
});
const model = z.object({
  id,
  label: z.string(),
  listed: z.boolean(),
  context: capacity.optional(),
  output: capacity.optional(),
});
export const connectionSchema = z.object({
  id: z.uuid(),
  name: id,
  url: z.string(),
  protocol,
  catalogProvider: z.string(),
  hasKey: z.boolean(),
  lastRefresh: z.number().nullable(),
  error: z.string().nullable(),
  models: z.array(model),
});
export const bindingSchema = z.object({
  agent,
  connection: z.uuid(),
  selected: z.array(id),
  overrides: z.record(
    z.string(),
    z.object({ context: override.optional(), output: override.optional() }),
  ),
});
const descriptor = z.object({
  id: agent,
  label: z.string(),
  detail: z.string(),
  protocols: z.array(protocol),
});
const defaults = z.partialRecord(agent, limits);
const snapshot = z.object({
  agents: z.array(descriptor),
  connections: z.array(connectionSchema),
  bindings: z.array(bindingSchema),
  defaults,
});
const connection = z.uuid();
const action = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("saveConnection"),
    id: connection.optional(),
    name: id,
    url: z.url({ protocol: /^https?$/ }),
    protocol,
    catalogProvider: z.string().trim(),
    key: z.string().optional(),
    /** Reuse the saved key of another connection on the same origin (copy flow). */
    copyKeyFrom: connection.optional(),
  }),
  z.object({ type: z.literal("deleteConnection"), connection }),
  z.object({ type: z.literal("refresh"), connection }),
  z.object({ type: z.literal("refreshStale") }),
  z.object({ type: z.literal("defaults"), agent, ...limits.shape }),
  z.object({
    type: z.literal("selection"),
    agent,
    connection,
    selected: z.array(id),
    changes: z
      .array(
        z.object({
          model: id,
          field: z.enum(["context", "output"]),
          value: positive.nullable(),
        }),
      )
      .optional(),
  }),
  z.object({
    type: z.literal("override"),
    agent,
    connection,
    model: id,
    field: z.enum(["context", "output"]),
    value: positive.nullable(),
  }),
  z.object({ type: z.literal("testConnection"), connection }),
]);
export type Action = z.infer<typeof action>;
export type Snapshot = z.infer<typeof snapshot>;
export type Connection = z.infer<typeof connectionSchema>;
export type Model = z.infer<typeof model>;
export type Binding = z.infer<typeof bindingSchema>;
export type Limits = z.infer<typeof limits>;
export type Override = z.infer<typeof override>;
export type Capacity = z.infer<typeof capacity>;
export const snapshotRpc = defineRpc({
  name: "manager.snapshot",
  input: z.object({}),
  output: snapshot,
});
const operation = z.object({
  message: z.string(),
  job: z.string().optional(),
  /** Toast severity; absent means success. */
  level: z.enum(["success", "info", "warning"]).optional(),
  /** The connection a saveConnection action created or updated. */
  connection: z.uuid().optional(),
});
export type Operation = z.infer<typeof operation>;
export const jobRpc = defineRpc({
  name: "manager.wait",
  input: z.object({ job: z.uuid() }),
  output: operation,
});
export const actionRpc = defineRpc({
  name: "manager.action",
  input: action,
  output: operation,
});
const nativeInput = z.object({ agent, cwd: z.string().min(1).optional() });
export const nativeCatalogRpc = defineRpc({
  name: "manager.native-models",
  input: nativeInput,
  output: z.array(z.object({ id, label: z.string() })),
});
