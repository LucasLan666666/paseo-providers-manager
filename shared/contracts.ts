import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { langSchema } from "./i18n";

/** The client's resolved language; optional so an older client still works. */
const withLang = z.object({ lang: langSchema.optional() });

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
  /** Where a catalog value came from, e.g. "zhipuai/glm-4.7". */
  ref: z.string().max(256).optional(),
});
/** A manual value. `ack` is the automatic value the user last confirmed it against. */
const override = z.object({ value: positive, ack: positive.optional() });
const limits = z.object({
  context: positive.optional(),
  output: positive.optional(),
});
export const modelKinds = [
  "chat",
  "embedding",
  "reranking",
  "image",
  "audio",
  "video",
  "other",
] as const;
export const capabilityFields = ["reasoning", "image", "tools"] as const;
const capabilities = z.object({
  reasoning: z.boolean().optional(),
  image: z.boolean().optional(),
  tools: z.boolean().optional(),
});
const model = z.object({
  id,
  label: z.string(),
  listed: z.boolean(),
  context: capacity.optional(),
  output: capacity.optional(),
  /** Non-chat models (embedding, image, …) cannot be used by a coding agent. */
  kind: z.enum(modelKinds).optional(),
  caps: capabilities.optional(),
  /** Values that need confirmation before they are used (guesses, unpublished output). */
  suggested: z
    .object({
      context: positive.optional(),
      output: positive.optional(),
      reason: z.enum(["guess", "output-unknown", "loose"]),
      ref: z.string().max(256).optional(),
    })
    .optional(),
  /** Full context window when `context` is an economical default (OpenAI 272K tier). */
  full: positive.optional(),
  /** Appeared in a refresh and not yet viewed in the model sheet. */
  fresh: z.boolean().optional(),
});
/** Per-model manual settings, shared by every agent on the connection. */
const modelSetting = z.object({
  context: override.optional(),
  output: override.optional(),
  reasoning: z.boolean().optional(),
  image: z.boolean().optional(),
  tools: z.boolean().optional(),
});
const probe = z.object({
  ok: z.boolean(),
  ms: z.number().nonnegative().optional(),
  /** Language-neutral detail: "HTTP 404 …" or the network error; the UI adds the localized part. */
  error: z.string().max(400).optional(),
  kind: z.enum(["http", "timeout", "unreachable"]).optional(),
  at: z.number(),
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
  /** Limits for models no source knows. Absent fields use 128K / 16K. */
  fallback: limits.optional(),
  settings: z.record(z.string(), modelSetting).optional(),
  probes: z.record(z.string(), probe).optional(),
});
export const bindingSchema = z.object({
  agent,
  connection: z.uuid(),
  selected: z.array(id),
  /** Model new sessions start with; absent means the first selected chat model. */
  default: id.optional(),
});
const descriptor = z.object({
  id: agent,
  label: z.string(),
  detail: z.string(),
  protocols: z.array(protocol),
});
const snapshot = z.object({
  agents: z.array(descriptor),
  connections: z.array(connectionSchema),
  bindings: z.array(bindingSchema),
  /** Icons Paseo reports for agents (plugin providers such as Muse), keyed by agent id. */
  icons: z.record(z.string(), z.string().max(65536)).optional(),
});
const connection = z.uuid();
const settingChange = z.discriminatedUnion("field", [
  z.object({
    model: id,
    field: z.enum(["context", "output"]),
    value: positive.nullable(),
  }),
  z.object({
    model: id,
    field: z.enum(capabilityFields),
    value: z.boolean().nullable(),
  }),
]);
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
  z.object({
    type: z.literal("selection"),
    agent,
    connection,
    selected: z.array(id),
    /** null clears the explicit default. */
    default: id.nullable().optional(),
    /** Manual limit / capability changes on the connection (shared by its agents). */
    changes: z.array(settingChange).optional(),
    fallback: limits.optional(),
    /** Apply the same selection to these agents too (each stays independent). */
    alsoApply: z.array(agent).optional(),
  }),
  z.object({ type: z.literal("settings"), connection, changes: z.array(settingChange) }),
  z.object({ type: z.literal("fallback"), connection, ...limits.shape }),
  z.object({
    type: z.literal("acceptSuggestions"),
    connection,
    models: z.array(id).optional(),
  }),
  z.object({ type: z.literal("markSeen"), connection }),
  z.object({
    type: z.literal("probe"),
    connection,
    models: z.array(id).min(1).max(200),
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
export type ModelKind = (typeof modelKinds)[number];
export type CapabilityField = (typeof capabilityFields)[number];
export type Capabilities = z.infer<typeof capabilities>;
export type ModelSetting = z.infer<typeof modelSetting>;
export type SettingChange = z.infer<typeof settingChange>;
export type Probe = z.infer<typeof probe>;
export const snapshotRpc = defineRpc({
  name: "manager.snapshot",
  input: withLang,
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
  input: z.object({ job: z.uuid() }).extend(withLang.shape),
  output: operation,
});
export const actionRpc = defineRpc({
  name: "manager.action",
  input: action.and(withLang),
  output: operation,
});
const nativeInput = z.object({ agent, cwd: z.string().min(1).optional() }).extend(withLang.shape);
export const nativeCatalogRpc = defineRpc({
  name: "manager.native-models",
  input: nativeInput,
  output: z.array(z.object({ id, label: z.string() })),
});
