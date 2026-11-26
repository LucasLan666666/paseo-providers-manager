import {
  anthropicBaseV1,
  assertModels,
  assertProtocol,
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
 * OpenCode v1 configuration, passed only through OPENCODE_CONFIG_CONTENT (Paseo
 * merges its bridge plugin into it). OpenCode's own config, data, sessions and
 * logins stay the user's real ones; earlier versions pointed the XDG roots at
 * private per-generation directories, which hid all of that and lost history
 * on every change. Per-model limit.context and limit.output are native fields.
 */
export async function opencodeProvider(
  connection: AdapterConnection,
  models: readonly AdapterModel[],
  _dir: string,
): Promise<BuiltProvider> {
  assertProtocol("OpenCode", connection.protocol, ["chat", "responses", "anthropic"]);
  assertModels(models);
  const limited = requireLimits("OpenCode", models);
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
              tool_call: model.caps?.tools ?? true,
              temperature: true,
              reasoning: model.caps?.reasoning ?? false,
              attachment: model.caps?.image ?? false,
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
      // Always present so a removed key cannot survive a provider-env merge and
      // an unauthenticated local gateway never receives an unrelated ambient key.
      PPM_GATEWAY_KEY: connection.key || "ppm-no-key",
    },
    models: modelChoices("opencode", models),
  };
}
