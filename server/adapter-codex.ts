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
} from "./adapter-common";
import type { CodexModelInfo } from "./codex-catalog";

function tomlString(value: string): string {
  return JSON.stringify(value);
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

/**
 * Codex knows the windows of its own models; models it doesn't know get a
 * generic fallback. `model_catalog_json` replaces the whole built-in catalog,
 * so the generated catalog is the bundled one with only these changes:
 *  - a known model whose context the user set manually gets that context
 *  - an unknown chat model gets an entry cloned from a model of its family
 *    (unknown models without one are left to Codex)
 * Returns undefined when nothing needs changing (Codex keeps its own catalog).
 */
export function codexCatalog(
  models: readonly AdapterModel[],
  bundled: readonly CodexModelInfo[] | undefined,
): CodexModelInfo[] | undefined {
  if (!bundled?.length) return undefined;
  const bySlug = new Map(bundled.map((entry) => [entry.slug, entry]));
  const replaced = new Map<string, CodexModelInfo>();
  const added: CodexModelInfo[] = [];
  for (const model of models) {
    if (model.chat === false || !model.context) continue;
    const known = bySlug.get(model.id);
    if (known) {
      if (model.contextSource !== "manual") continue;
      replaced.set(model.id, {
        ...known,
        context_window: model.context,
        max_context_window: Math.max(model.context, known.max_context_window ?? 0),
      });
      continue;
    }
    const template = templateFor(model.id, bundled);
    if (!template) continue;
    added.push({
      ...template,
      slug: model.id,
      display_name: model.label.trim() || model.id,
      description: `${model.id} (Providers Manager)`,
      visibility: "list",
      context_window: model.context,
      max_context_window: model.context,
      input_modalities: model.caps?.image ? ["text", "image"] : ["text"],
      upgrade: null,
      availability_nux: null,
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
 * no per-model output limit, so only context windows are written (through a
 * model catalog file referenced by model_catalog_json, see codexCatalog).
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
    models: modelChoices("codex", models),
  };
}
