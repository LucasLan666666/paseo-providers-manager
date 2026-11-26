import type { Capabilities, Model, ModelKind } from "../shared/contracts";

/**
 * Global models.dev matching by model name.
 *
 * A relay serves models from many vendors under one URL, so one catalog
 * provider per connection cannot describe it. Instead every model id is looked
 * up across all models.dev providers and the vendor's own entry wins:
 *
 *  - exact / normalized hit on a vendor-owned row → used automatically
 *  - output listed as equal to the context (models.dev's "unknown") → the
 *    context is used, the output becomes a suggestion
 *  - OpenAI rows priced in a 272K context tier → 272K is the default context
 *    and the full window is offered separately
 *  - only third-party or punctuation-insensitive hits, or a family guess →
 *    suggestions that need confirmation
 *  - non-chat rows (embedding, image, …) are classified so they can't be selected
 *
 * Gateway values always win; nothing here overwrites a field already set.
 */

interface Row {
  pid: string;
  mid: string;
  ctx?: number;
  out?: number;
  canon?: string;
  vendor?: string;
  status?: string;
  kind: ModelKind;
  caps: Capabilities;
  economy?: number;
}

interface Index {
  exact: Map<string, Row[]>;
  norm: Map<string, Row[]>;
  loose: Map<string, Row[]>;
  byVendor: Map<string, Row[]>;
}

/** Plan / regional providers that publish a vendor's models as that vendor. */
const VENDOR_ALIASES: Record<string, string> = {
  zai: "zhipuai",
  "zai-coding-plan": "zhipuai",
  "zhipuai-coding-plan": "zhipuai",
  "kimi-code-plan-global": "moonshotai",
  "kimi-code-plan-cn": "moonshotai",
  "moonshotai-cn": "moonshotai",
  "minimax-cn": "minimax",
  "minimax-coding-plan": "minimax",
  "minimax-cn-coding-plan": "minimax",
  "alibaba-cn": "alibaba",
  "google-vertex": "google",
};

const ID_VENDOR_HINTS: Array<[RegExp, string]> = [
  [/^claude/, "anthropic"],
  [/^(gpt|o\d|codex|chatgpt)/, "openai"],
  [/^(gemini|gemma)/, "google"],
  [/^grok/, "xai"],
  [/^glm/, "zhipuai"],
  [/^(kimi|k\d)/, "moonshotai"],
  [/^minimax/, "minimax"],
  [/^deepseek/, "deepseek"],
  [/^(qwen|qwq)/, "alibaba"],
];

const NON_CHAT_NAMES: Array<[RegExp, ModelKind]> = [
  [/rerank/, "reranking"],
  [/embed|^bge-|text-embedding/, "embedding"],
  [/(^|[-_])image([-_]|$)|^gpt-image|dall-e|imagen|flux|seedream/, "image"],
  [/tts|speech|whisper|transcri/, "audio"],
  [/(^|[-_])(sora|veo|seedance)|[-_]video([-_]|$)/, "video"],
];

const RELAY_SUFFIX = /-(openai-compact|compact|highspeed|fast|turbo-preview|thinking|nothinking|non-thinking)$/;

const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function normalizeModelId(raw: string): string {
  let id = raw.trim().toLowerCase().replace(/^models\//, "");
  if (id.includes("/")) id = id.slice(id.lastIndexOf("/") + 1);
  return id
    .replace(/@[\w.-]+$/, "")
    .replace(/:latest$/, "")
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    .replace(/-latest$/, "");
}

/** Ollama-style size tags ("qwen3-embedding:8b") are part of the model name. */
function idVariants(raw: string): string[] {
  const id = normalizeModelId(raw);
  const tagged = /^(.*):([a-z0-9._-]+)$/.exec(id);
  return tagged ? [`${tagged[1]}-${tagged[2]}`] : [id];
}

const looseKey = (value: string) => value.replace(/[^a-z0-9]/g, "");

function classify(entry: Record<string, unknown>): ModelKind {
  const type = typeof entry.type === "string" ? entry.type : undefined;
  if (type && type !== "chat") {
    if (type === "embedding" || type === "reranking" || type === "image" || type === "video") return type;
    if (type === "speech" || type === "transcription" || type === "realtime") return "audio";
    return "other";
  }
  const output = isRecord(entry.modalities) && Array.isArray(entry.modalities.output)
    ? (entry.modalities.output as unknown[])
    : [];
  if (output.length && !output.includes("text")) {
    if (output.includes("image")) return "image";
    if (output.includes("video")) return "video";
    if (output.includes("audio")) return "audio";
    return "other";
  }
  return "chat";
}

function capabilitiesOf(entry: Record<string, unknown>): Capabilities {
  const input = isRecord(entry.modalities) && Array.isArray(entry.modalities.input)
    ? (entry.modalities.input as unknown[])
    : undefined;
  return {
    ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
    ...(input ? { image: input.includes("image") } : {}),
    ...(typeof entry.tool_call === "boolean" ? { tools: entry.tool_call } : {}),
  };
}

/** OpenAI prices a long context as a separate tier; that tier start is the economical window. */
function economyWindow(entry: Record<string, unknown>, context: number | undefined): number | undefined {
  const cost = isRecord(entry.cost) ? entry.cost : undefined;
  if (!cost || !Array.isArray(cost.tiers) || !context) return undefined;
  for (const tier of cost.tiers) {
    if (!isRecord(tier) || !isRecord(tier.tier)) continue;
    if (tier.tier.type !== "context") continue;
    const size = positive(tier.tier.size);
    if (size && size < context) return size;
  }
  return undefined;
}

const indexes = new WeakMap<object, Index>();

function buildIndex(raw: unknown): Index | undefined {
  if (!isRecord(raw)) return undefined;
  const cached = indexes.get(raw);
  if (cached) return cached;
  const container = isRecord(raw.providers) ? raw.providers : raw;
  // A provider id that other rows name as their canonical vendor owns those models.
  const vendors = new Set<string>();
  for (const provider of Object.values(container)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    for (const entry of Object.values(provider.models)) {
      if (!isRecord(entry) || typeof entry.canonical_model_id !== "string") continue;
      const vendor = entry.canonical_model_id.split("/")[0];
      if (vendor && isRecord(container[vendor])) vendors.add(vendor);
    }
  }
  const index: Index = { exact: new Map(), norm: new Map(), loose: new Map(), byVendor: new Map() };
  const push = (map: Map<string, Row[]>, key: string, row: Row) => {
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  };
  for (const [pid, provider] of Object.entries(container)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    const vendor = VENDOR_ALIASES[pid] ?? (vendors.has(pid) ? pid : undefined);
    for (const [mid, entry] of Object.entries(provider.models)) {
      if (!isRecord(entry)) continue;
      const limit = isRecord(entry.limit) ? entry.limit : {};
      const ctx = positive(limit.context);
      const row: Row = {
        pid,
        mid,
        ctx,
        out: positive(limit.output),
        canon: typeof entry.canonical_model_id === "string" ? entry.canonical_model_id : undefined,
        vendor,
        status: typeof entry.status === "string" ? entry.status : undefined,
        kind: classify(entry),
        caps: capabilitiesOf(entry),
        economy: economyWindow(entry, ctx),
      };
      push(index.exact, mid, row);
      push(index.norm, normalizeModelId(mid), row);
      push(index.loose, looseKey(normalizeModelId(mid)), row);
      if (vendor) push(index.byVendor, vendor, row);
    }
  }
  indexes.set(raw, index);
  return index;
}

/** Most common value; ties go to the smaller one (safer for limits). */
function modeThenMin(values: Array<number | undefined>): number | undefined {
  const counts = new Map<number, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
}

function majority<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

const vendorFromId = (id: string) => ID_VENDOR_HINTS.find(([re]) => re.test(normalizeModelId(id)))?.[1];

interface Match {
  confident: boolean;
  pool: Row[];
  pick: Row;
  ctx?: number;
  out?: number;
}

function lookup(index: Index, id: string, restrict?: string): Match | undefined {
  const filter = (rows: Row[] | undefined) => (rows ?? []).filter((row) => !restrict || row.pid === restrict);
  let hits = filter(index.exact.get(id));
  let loose = false;
  for (const variant of hits.length ? [] : idVariants(id)) {
    hits = filter(index.norm.get(variant));
    if (hits.length) break;
  }
  if (!hits.length && !restrict) {
    for (const variant of idVariants(id)) {
      hits = filter(index.loose.get(looseKey(variant)));
      if (hits.length) {
        loose = true;
        break;
      }
    }
  }
  if (!hits.length) return undefined;
  const vendor =
    restrict ?? majority(hits.map((row) => row.canon?.split("/")[0]).filter((v): v is string => !!v)) ?? vendorFromId(id);
  // The vendor's own provider first, then its plan/regional aliases. Without a
  // known vendor no row counts as official, so the values stay suggestions.
  let official = vendor ? hits.filter((row) => row.pid === vendor) : [];
  if (!official.length && vendor) official = hits.filter((row) => row.vendor === vendor);
  if (!official.length && vendor && !restrict) {
    // A relay row's canonical id points at the vendor's own entry.
    const canonical = new Set(hits.map((row) => row.canon).filter((c): c is string => !!c));
    official = [...canonical]
      .flatMap((c) => index.norm.get(normalizeModelId(c)) ?? [])
      .filter((row) => row.vendor === vendor || row.pid === vendor);
  }
  const live = (rows: Row[]) => rows.filter((row) => row.status !== "deprecated");
  const pool = [live(official), official, live(hits), hits].find((rows) => rows.length)!;
  const ctx = modeThenMin(pool.map((row) => row.ctx));
  const out = modeThenMin(pool.map((row) => row.out));
  const pick =
    pool.find((row) => row.ctx === ctx && row.pid === vendor) ?? pool.find((row) => row.ctx === ctx) ?? pool[0];
  return { confident: official.length > 0 && !loose, pool, pick, ctx, out };
}

/** OpenAI's economical window (272K price tier) when the matched row has one. */
function defaultWindow(match: Match): number | undefined {
  const vendor = match.pick.vendor ?? match.pick.pid;
  return vendor === "openai" && match.pick.economy ? match.pick.economy : match.ctx;
}

/** Family guesses for ids no catalog row matches. The smallest family value wins. */
function guess(index: Index, id: string): { ctx?: number; out?: number; ref: string } | undefined {
  const normalized = normalizeModelId(id);
  const suffix = RELAY_SUFFIX.exec(normalized);
  if (suffix) {
    const base = lookup(index, normalized.slice(0, suffix.index));
    if (base) return { ctx: defaultWindow(base), out: base.out, ref: `${base.pick.pid}/${base.pick.mid}` };
  }
  const sized = /^(.*)-(\d{2,4})k$/.exec(normalized);
  if (sized) {
    const base = lookup(index, sized[1]);
    const ctx = Number(sized[2]) * 1024;
    if (base) return { ctx, out: base.out && base.out < ctx ? base.out : undefined, ref: `${base.pick.pid}/${base.pick.mid}` };
  }
  const vendor = vendorFromId(normalized);
  if (vendor) {
    const children = (index.byVendor.get(vendor) ?? []).filter(
      (row) => normalizeModelId(row.mid).startsWith(`${normalized}-`) && row.kind === "chat",
    );
    if (children.length) {
      const ctxs = children
        .map((row) => (vendor === "openai" && row.economy ? row.economy : row.ctx))
        .filter((v): v is number => !!v);
      const outs = children.map((row) => row.out).filter((v): v is number => !!v);
      return {
        ctx: ctxs.length ? Math.min(...ctxs) : undefined,
        out: outs.length ? Math.min(...outs) : undefined,
        ref: `${vendor}/${normalized}-*`,
      };
    }
  }
  // Parent: drop the last "-part" while the remaining name still has a version digit.
  let parent = normalized;
  while (/-[^-]+$/.test(parent)) {
    parent = parent.replace(/-[^-]+$/, "");
    if (!/\d/.test(parent) || /^(gpt-image|codex)$/.test(parent)) break;
    const base = lookup(index, parent);
    if (base?.confident) return { ctx: defaultWindow(base), out: base.out, ref: `${base.pick.pid}/${base.pick.mid}` };
  }
  return undefined;
}

function nameKind(id: string): ModelKind | undefined {
  const normalized = normalizeModelId(id);
  return NON_CHAT_NAMES.find(([re]) => re.test(normalized))?.[1];
}

/** Fill missing limits, capabilities, kind and suggestions in place. */
export function enrichModels(models: Model[], catalog: unknown, options: { provider?: string } = {}): void {
  const index = buildIndex(catalog);
  for (const model of models) {
    const match = index ? lookup(index, model.id, options.provider || undefined) : undefined;
    if (!match) {
      const byName = model.kind ?? nameKind(model.id);
      if (byName) model.kind = byName;
      if (model.kind && model.kind !== "chat") continue;
      const family = index && !options.provider ? guess(index, model.id) : undefined;
      if (family && (family.ctx || family.out) && (!model.context || !model.output)) {
        const out = family.out && family.ctx && family.out >= family.ctx ? undefined : family.out;
        model.suggested = {
          ...(model.context ? {} : family.ctx ? { context: family.ctx } : {}),
          ...(model.output ? {} : out ? { output: out } : {}),
          reason: "guess",
          ref: family.ref,
        };
        if (model.suggested.context === undefined && model.suggested.output === undefined) delete model.suggested;
      }
      continue;
    }
    const ref = `${match.pick.pid}/${match.pick.mid}`;
    const kind = majority(match.pool.map((row) => row.kind)) ?? "chat";
    model.kind ??= kind === "chat" ? (nameKind(model.id) ?? "chat") : kind;
    if (model.kind !== "chat") continue;
    model.caps = { ...match.pick.caps, ...(model.caps ?? {}) };
    // An explicit catalog provider keeps limits strict (exact id, discover());
    // it only contributes capabilities and the model kind here.
    if (options.provider) continue;
    if (!match.confident) {
      // Third-party or punctuation-insensitive hit: offer it, don't apply it.
      const out = match.out && match.ctx && match.out >= match.ctx ? undefined : match.out;
      const suggested = {
        ...(model.context || !match.ctx ? {} : { context: match.ctx }),
        ...(model.output || !out ? {} : { output: out }),
      };
      if (Object.keys(suggested).length) model.suggested = { ...suggested, reason: "loose", ref };
      continue;
    }
    const context = defaultWindow(match);
    if (!model.context && context) {
      if (match.ctx && context < match.ctx) model.full = match.ctx;
      model.context = { value: context, source: "catalog", ref };
    }
    if (!model.output && match.out) {
      if (match.ctx && match.out >= match.ctx) {
        // models.dev lists an unpublished output as equal to the context.
        model.suggested = {
          output: Math.min(32_768, Math.floor(match.ctx / 4)),
          reason: "output-unknown",
          ref,
        };
      } else model.output = { value: match.out, source: "catalog", ref };
    }
  }
}
