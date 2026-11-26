import type {
  Binding,
  CapabilityField,
  Connection,
  Limits,
  Model,
  ModelSetting,
} from "./contracts";

/** Used for models no source knows, unless the connection sets its own fallback. */
export const FALLBACK_LIMITS = { context: 128_000, output: 16_384 } as const;
/** An automatic output that reached the window is lowered to at most this. */
export const CLAMPED_OUTPUT_MAX = 32_768;

export type LimitField = "context" | "output";
export type LimitSource = "manual" | "gateway" | "catalog" | "fallback";

export interface ResolvedLimit {
  value: number;
  source: LimitSource;
  ref?: string;
  /** An automatic output was lowered so it stays below the context window. */
  clamped?: boolean;
}

export interface ResolvedModel {
  context: ResolvedLimit;
  output: ResolvedLimit;
  caps: Record<CapabilityField, boolean>;
  capsManual: Partial<Record<CapabilityField, boolean>>;
  /** A suggestion (guess, unpublished output) is waiting for confirmation. */
  pending: boolean;
  chat: boolean;
}

/** Capability defaults when neither a manual value nor the catalog says otherwise. */
const CAPABILITY_DEFAULTS: Record<CapabilityField, boolean> = {
  reasoning: false,
  image: false,
  tools: true,
};

type ConnectionLimits = Pick<Connection, "fallback" | "settings">;

export function fallbackLimits(connection: ConnectionLimits): Required<Limits> {
  return {
    context: connection.fallback?.context ?? FALLBACK_LIMITS.context,
    output: connection.fallback?.output ?? FALLBACK_LIMITS.output,
  };
}

export function isChatModel(model: Pick<Model, "kind">): boolean {
  return model.kind === undefined || model.kind === "chat";
}

/** Review/auto-approval helpers that should never be a session's default model. */
export function isHelperModel(id: string): boolean {
  return /(^|[-_/])auto[-_]?review$|^codex-auto-review/i.test(id);
}

/**
 * The limits and capabilities one model really uses, shared by config
 * generation, "测试全部模型" and the UI: manual value → gateway value →
 * catalog value → connection fallback. An automatic output that would fill the
 * whole window is lowered to a quarter of it (at most 32K); a manual one is
 * left alone and reported by `limitIssue`.
 */
export function resolveModel(connection: ConnectionLimits, model: Model): ResolvedModel {
  const setting: ModelSetting = connection.settings?.[model.id] ?? {};
  const fallback = fallbackLimits(connection);
  const pick = (field: LimitField): ResolvedLimit => {
    const manual = setting[field]?.value;
    if (manual !== undefined) return { value: manual, source: "manual" };
    const capacity = model[field];
    if (capacity) return { value: capacity.value, source: capacity.source, ref: capacity.ref };
    return { value: fallback[field], source: "fallback" };
  };
  const context = pick("context");
  let output = pick("output");
  if (output.source !== "manual" && output.value >= context.value) {
    output = {
      ...output,
      value: Math.max(1, Math.min(CLAMPED_OUTPUT_MAX, Math.floor(context.value / 4))),
      clamped: true,
    };
  }
  const caps = {} as Record<CapabilityField, boolean>;
  const capsManual: Partial<Record<CapabilityField, boolean>> = {};
  for (const field of ["reasoning", "image", "tools"] as const) {
    const manual = setting[field];
    if (manual !== undefined) capsManual[field] = manual;
    caps[field] = manual ?? model.caps?.[field] ?? CAPABILITY_DEFAULTS[field];
  }
  const suggestion = model.suggested;
  // A suggestion is pending only while no real value (manual or automatic) exists.
  const pending =
    suggestion !== undefined &&
    ((suggestion.context !== undefined && setting.context === undefined && !model.context) ||
      (suggestion.output !== undefined && setting.output === undefined && !model.output));
  return { context, output, caps, capsManual, pending, chat: isChatModel(model) };
}

export type LimitIssue = { kind: "order"; context: number; output: number };

/** Only a manual output can reach the window now; automatic ones are clamped. */
export function limitIssue(resolved: ResolvedModel): LimitIssue | undefined {
  if (resolved.output.value >= resolved.context.value)
    return { kind: "order", context: resolved.context.value, output: resolved.output.value };
  return undefined;
}

/** The model new sessions start with: the explicit default, else the first chat model. */
export function defaultModelId(
  binding: Pick<Binding, "selected" | "default">,
  connection: Pick<Connection, "models">,
): string | undefined {
  if (binding.default && binding.selected.includes(binding.default)) return binding.default;
  const byId = new Map(connection.models.map((model) => [model.id, model]));
  return (
    binding.selected.find((id) => {
      const model = byId.get(id);
      return (!model || isChatModel(model)) && !isHelperModel(id);
    }) ?? binding.selected[0]
  );
}

/** Picker order: the default model first, then the rest by name. */
export function orderedSelection(
  binding: Pick<Binding, "selected" | "default">,
  connection: Pick<Connection, "models">,
): string[] {
  const first = defaultModelId(binding, connection);
  const labels = new Map(connection.models.map((model) => [model.id, model.label || model.id]));
  const rest = binding.selected
    .filter((id) => id !== first)
    .sort((a, b) => naturalCompare(labels.get(a) ?? a, labels.get(b) ?? b) || naturalCompare(a, b));
  return first === undefined ? rest : [first, ...rest];
}

/**
 * Case-insensitive compare where digit runs compare as numbers, so "gpt-6.2"
 * sorts before "gpt-6.10". No Intl: this also runs in React Native.
 */
export function naturalCompare(left: string, right: string): number {
  const a = left.toLowerCase().match(/\d+|\D+/g) ?? [];
  const b = right.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === y) continue;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) return Number(x) - Number(y) || x.length - y.length;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
