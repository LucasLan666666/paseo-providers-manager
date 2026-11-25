import { join } from "node:path";
import {
  assertModels,
  assertProtocol,
  childDir,
  ensurePrivateDir,
  modelChoices,
  openAiBase,
  writePrivateFile,
  GATEWAY_KEY_ENV,
  type AdapterConnection,
  type AdapterModel,
  type BuiltProvider,
} from "./adapter-common";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Codex reads routing from $CODEX_HOME/config.toml. Paseo's custom-provider
 * magic only generates a Responses provider when OPENAI_BASE_URL is present;
 * writing the same model_providers entry ourselves also covers a future Paseo
 * version and keeps the generated dir authoritative.
 *
 * Codex 0.172 removed wire_api = "chat"; chat is deliberately rejected.
 */
export async function codexProvider(
  connection: AdapterConnection,
  models: readonly AdapterModel[],
  dir: string,
): Promise<BuiltProvider> {
  assertProtocol("Codex", connection.protocol, ["responses"]);
  assertModels(models);
  const codexHome = await ensurePrivateDir(childDir(dir, "codex"));
  const key = connection.key;
  const lines = [
    `model = ${tomlString(models[0].id)}`,
    `model_provider = "ppm"`,
    "",
    "[model_providers.ppm]",
    `name = ${tomlString(connection.name || "PPM gateway")}`,
    `base_url = ${tomlString(openAiBase(connection.url))}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
  ];
  lines.push(`env_key = ${tomlString(GATEWAY_KEY_ENV)}`);
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
