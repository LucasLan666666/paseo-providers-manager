import { join } from "node:path";
import {
  assertModels,
  assertProtocol,
  childDir,
  ensurePrivateDir,
  modelChoices,
  openAiBase,
  writePrivateJson,
  GATEWAY_KEY_ENV,
  type AdapterConnection,
  type AdapterModel,
  type BuiltProvider,
  type ProviderModelChoice,
} from "./adapter-common";
import type { CodexModelInfo } from "./codex-catalog";
import { L } from "./i18n";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexModelChoices(
  models: readonly AdapterModel[],
  catalog: readonly CodexModelInfo[] | undefined,
): ProviderModelChoice[] {
  const bySlug = new Map(catalog?.map((entry) => [entry.slug, entry]));
  return modelChoices("codex", models).map((choice, index) => {
    if (models[index].chat === false) return choice;
    if (models[index].reasoningOverride === false) return { ...choice, thinkingOptions: [] };
    const entry = bySlug.get(choice.id);
    if (!entry || !Array.isArray(entry.supported_reasoning_levels)) return choice;
    const thinkingOptions = reasoningLevels(entry).map(({ effort, description }) => ({
      id: effort,
      label: effort,
      ...(description ? { description } : {}),
      ...(effort === entry.default_reasoning_level ? { isDefault: true } : {}),
    }));
    return { ...choice, thinkingOptions };
  });
}

function reasoningLevels(entry: CodexModelInfo): NonNullable<CodexModelInfo["supported_reasoning_levels"]> {
  if (!Array.isArray(entry.supported_reasoning_levels)) return [];
  const levels = new Map<string, { effort: string; description?: string }>();
  for (const level of entry.supported_reasoning_levels) {
    const effort = level?.effort;
    if (typeof effort !== "string" || !effort.trim() || levels.has(effort)) continue;
    levels.set(effort, {
      effort,
      ...(typeof level.description === "string" && level.description ? { description: level.description } : {}),
    });
  }
  return [...levels.values()];
}

function reasoningMetadata(model: AdapterModel, source: CodexModelInfo, trusted: boolean) {
  if (model.reasoningOverride === false || !trusted) {
    return { supported_reasoning_levels: [], default_reasoning_level: null };
  }
  const allowed = model.codexReasoning?.efforts;
  const levels = reasoningLevels(source).filter(({ effort }) => !allowed || allowed.includes(effort));
  const defaultLevel = levels.find(({ effort }) => effort === source.default_reasoning_level) ?? levels[0];
  return { supported_reasoning_levels: levels, default_reasoning_level: defaultLevel?.effort ?? null };
}

/**
 * The bundled entry of the same family (parent "gpt-5.5" for
 * "gpt-5.5-openai-compact", or a child "gpt-6-sol" for "gpt-6"). An entry
 * carries request-shape settings (reasoning levels, tool modes, instructions),
 * so an unrelated model is never cloned: without a family member Codex keeps
 * its own handling of the unknown model.
 */
function templateFor(slug: string, bundled: readonly CodexModelInfo[]): CodexModelInfo | undefined {
  return bundled
    .filter((entry) => slug.startsWith(`${entry.slug}-`) || entry.slug.startsWith(`${slug}-`))
    .sort((a, b) => b.slug.length - a.slug.length)[0];
}

/** Overlay the bundled catalog, which Codex replaces wholesale when a custom file is supplied. */
export function codexCatalog(
  models: readonly AdapterModel[],
  bundled: readonly CodexModelInfo[] | undefined,
): CodexModelInfo[] | undefined {
  if (!bundled?.length) return undefined;
  const bySlug = new Map(bundled.map((entry) => [entry.slug, entry]));
  const replaced = new Map<string, CodexModelInfo>();
  const added: CodexModelInfo[] = [];
  for (const model of models) {
    if (model.chat === false) continue;
    const known = bySlug.get(model.id);
    if (known) {
      const context = model.contextSource === "manual" ? model.context : undefined;
      const overrideReasoning = model.reasoningOverride === false || model.codexReasoning?.efforts !== undefined;
      if (!context && !overrideReasoning) continue;
      replaced.set(model.id, {
        ...known,
        ...(context ? {
          context_window: context,
          max_context_window: Math.max(context, known.max_context_window ?? 0),
        } : {}),
        ...(overrideReasoning ? reasoningMetadata(model, known, true) : {}),
      });
      continue;
    }
    const mappedSlug = model.codexReasoning?.model;
    const mapped = mappedSlug ? bySlug.get(mappedSlug) : undefined;
    if (mappedSlug && !mapped) {
      throw new Error(L(
        `${model.id} 的 Codex 映射 ${mappedSlug} 不在捆绑目录中。`,
        `Codex mapping ${mappedSlug} for ${model.id} is missing from the bundled catalog.`,
      ));
    }
    const family = model.context ? templateFor(model.id, bundled) : undefined;
    const template = mapped ?? family;
    if (!template) continue;
    added.push({
      ...template,
      slug: model.id,
      display_name: model.label.trim() || model.id,
      description: `${model.id} (Providers Manager)`,
      visibility: "list",
      ...(model.context ? { context_window: model.context, max_context_window: model.context } : {}),
      input_modalities: model.caps?.image ? ["text", "image"] : ["text"],
      upgrade: null,
      availability_nux: null,
      ...reasoningMetadata(model, template, mapped !== undefined),
    });
  }
  if (!replaced.size && !added.length) return undefined;
  return [...bundled.map((entry) => replaced.get(entry.slug) ?? entry), ...added];
}

/**
 * The gateway is passed as `codex -c key=value` overrides (Paseo launches the
 * provider command followed by `app-server`), so CODEX_HOME stays the user's
 * real ~/.codex: AGENTS.md, skills, MCP servers, sessions and login are shared
 * with their own Codex. Earlier versions used a private CODEX_HOME per
 * generation, which hid all of that and lost history on every change.
 *
 * Codex 0.172 removed wire_api = "chat"; chat is deliberately rejected. Codex has
 * no per-model output limit. Context and reasoning overrides are written to
 * the model catalog file referenced by model_catalog_json.
 */
export async function codexProvider(
  connection: AdapterConnection,
  models: readonly AdapterModel[],
  dir: string,
  bundled?: readonly CodexModelInfo[],
): Promise<BuiltProvider> {
  assertProtocol("Codex", connection.protocol, ["responses"]);
  assertModels(models);
  const key = connection.key;
  const config: Array<[string, string]> = [
    ["model", tomlString(models[0].id)],
    ["model_provider", tomlString("ppm")],
    ["model_providers.ppm.name", tomlString(connection.name || "PPM gateway")],
    ["model_providers.ppm.base_url", tomlString(openAiBase(connection.url))],
    ["model_providers.ppm.wire_api", tomlString("responses")],
    ["model_providers.ppm.requires_openai_auth", "false"],
    ["model_providers.ppm.env_key", tomlString(GATEWAY_KEY_ENV)],
  ];
  const catalog = codexCatalog(models, bundled);
  if (catalog) {
    const path = join(await ensurePrivateDir(childDir(dir, "codex")), "models.json");
    await writePrivateJson(path, { models: catalog });
    config.push(["model_catalog_json", tomlString(path)]);
  }
  return {
    extends: "codex",
    command: ["codex", ...config.flatMap(([name, value]) => ["-c", `${name}=${value}`])],
    env: {
      // Always present so a key removed in a later generation cannot survive a
      // deep merge of provider env, and so an unauthenticated local gateway still
      // receives a disposable credential instead of an unrelated ambient one.
      [GATEWAY_KEY_ENV]: key || "ppm-no-key",
    },
    models: codexModelChoices(models, catalog ?? bundled),
  };
}
