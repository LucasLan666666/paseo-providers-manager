import { join } from "node:path";
import {
  anthropicBaseV1,
  assertModels,
  assertProtocol,
  childDir,
  ensurePrivateDir,
  modelChoices,
  openAiBase,
  requireLimits,
  type AdapterConnection,
  type AdapterModel,
  type BuiltProvider,
} from "./adapter-common";

const PROVIDER = "ppm";

function packageFor(protocol: AdapterConnection["protocol"]): string {
  if (protocol === "chat") return "@ai-sdk/openai-compatible";
  if (protocol === "responses") return "@ai-sdk/openai";
  return "@ai-sdk/anthropic";
}

/**
 * OpenCode v1 configuration. Paseo merges its bridge plugin into
 * OPENCODE_CONFIG_CONTENT, so the provider entry stays intact while every
 * generated process also gets private XDG roots. Per-model limit.context and
 * limit.output are native OpenCode fields.
 */
export async function opencodeProvider(
  connection: AdapterConnection,
  models: readonly AdapterModel[],
  dir: string,
): Promise<BuiltProvider> {
  assertProtocol("OpenCode", connection.protocol, ["chat", "responses", "anthropic"]);
  assertModels(models);
  const limited = requireLimits("OpenCode", models);
  const home = await ensurePrivateDir(childDir(dir, "opencode"));
  const configRoot = await ensurePrivateDir(join(home, "config"));
  const dataRoot = await ensurePrivateDir(join(home, "data"));
  const stateRoot = await ensurePrivateDir(join(home, "state"));
  const cacheRoot = await ensurePrivateDir(join(home, "cache"));
  const configDir = await ensurePrivateDir(join(home, "config-dir"));
  const baseURL =
    connection.protocol === "anthropic"
      ? anthropicBaseV1(connection.url)
      : openAiBase(connection.url);
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `${PROVIDER}/${models[0].id}`,
    provider: {
      [PROVIDER]: {
        npm: packageFor(connection.protocol),
        name: connection.name || "PPM gateway",
        options: {
          baseURL,
          apiKey: "{env:PPM_GATEWAY_KEY}",
        },
        models: Object.fromEntries(
          limited.map((model) => [
            model.id,
            {
              name: model.label.trim() || model.id,
              limit: { context: model.context, output: model.output },
              tool_call: true,
              temperature: true,
              reasoning: false,
              attachment: false,
            },
          ]),
        ),
      },
    },
  };
  return {
    extends: "opencode",
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_CONFIG_DIR: configDir,
      XDG_CONFIG_HOME: configRoot,
      XDG_DATA_HOME: dataRoot,
      XDG_STATE_HOME: stateRoot,
      XDG_CACHE_HOME: cacheRoot,
      // Always present so a removed key cannot survive a provider-env merge and
      // an unauthenticated local gateway never receives an unrelated ambient key.
      PPM_GATEWAY_KEY: connection.key || "ppm-no-key",
    },
    models: modelChoices("opencode", models),
  };
}
