import { join } from "node:path";
import {
  assertModels,
  assertProtocol,
  childDir,
  ensurePrivateDir,
  modelChoices,
  openAiBase,
  writePrivateFile,
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

/** The bundled entry closest to an unknown slug: its family parent or child, else any listed model. */
function templateFor(slug: string, bundled: readonly CodexModelInfo[]): CodexModelInfo {
  const related = bundled
    .filter((entry) => slug.startsWith(`${entry.slug}-`) || entry.slug.startsWith(`${slug}-`))
    .sort((a, b) => b.slug.length - a.slug.length);
  return related[0] ?? bundled.find((entry) => entry.visibility === "list") ?? bundled[0];
}

/**
 * Codex knows the windows of its own models; models it doesn't know get a
 * generic fallback. `model_catalog_json` replaces the whole built-in catalog,
 * so the generated catalog is the bundled one with only these changes:
 *  - a known model whose context the user set manually gets that context
 *  - an unknown chat model gets an entry cloned from its closest known model
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
    added.push({
      ...templateFor(model.id, bundled),
      slug: model.id,
      display_name: model.label.trim() || model.id,
      description: `${model.id}（Providers Manager）`,
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
 * Codex reads routing from $CODEX_HOME/config.toml. Paseo's custom-provider
 * magic only generates a Responses provider when OPENAI_BASE_URL is present;
 * writing the same model_providers entry ourselves also covers a future Paseo
 * version and keeps the generated dir authoritative.
 *
 * Codex 0.172 removed wire_api = "chat"; chat is deliberately rejected. Codex has
 * no per-model output limit, so only context windows are written.
 */
export async function codexProvider(
  connection: AdapterConnection,
  models: readonly AdapterModel[],
  dir: string,
  bundled?: readonly CodexModelInfo[],
): Promise<BuiltProvider> {
  assertProtocol("Codex", connection.protocol, ["responses"]);
  assertModels(models);
  const codexHome = await ensurePrivateDir(childDir(dir, "codex"));
  const key = connection.key;
  const catalog = codexCatalog(models, bundled);
  const lines = [
    `model = ${tomlString(models[0].id)}`,
    `model_provider = "ppm"`,
  ];
  if (catalog) {
    const path = join(codexHome, "models.json");
    await writePrivateJson(path, { models: catalog });
    lines.push(`model_catalog_json = ${tomlString(path)}`);
  }
  lines.push(
    "",
    "[model_providers.ppm]",
    `name = ${tomlString(connection.name || "PPM gateway")}`,
    `base_url = ${tomlString(openAiBase(connection.url))}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    `env_key = ${tomlString(GATEWAY_KEY_ENV)}`,
  );
  await writePrivateFile(join(codexHome, "config.toml"), `${lines.join("\n")}\n`);
  return {
    extends: "codex",
    env: {
      CODEX_HOME: codexHome,
      // Always present so a key removed in a later generation cannot survive a
      // deep merge of provider env, and so an unauthenticated local gateway still
      // receives a disposable credential instead of an unrelated ambient one.
      [GATEWAY_KEY_ENV]: key || "ppm-no-key",
    },
    models: modelChoices("codex", models),
  };
}
