import { join } from "node:path";
import {
  anthropicBaseV1,
  assertModels,
  assertProtocol,
  modelChoices,
  openAiBase,
  requireLimits,
  writePrivateJson,
  writePrivateFile,
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

/** The session-open hook passes this private config to a dedicated helper. */
export async function opencodeProvider(
  connection: AdapterConnection,
  models: readonly AdapterModel[],
  dir: string,
): Promise<BuiltProvider> {
  assertProtocol("OpenCode", connection.protocol, ["chat", "responses", "anthropic"]);
  assertModels(models);
  const limited = requireLimits("OpenCode", models);
  const baseURL =
    connection.protocol === "anthropic"
      ? anthropicBaseV1(connection.url)
      : openAiBase(connection.url);
  const keyPath = join(dir, "gateway.key");
  await writePrivateFile(keyPath, connection.key || "ppm-no-key");
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `${PROVIDER}/${models[0].id}`,
    provider: {
      [PROVIDER]: {
        npm: packageFor(connection.protocol),
        name: connection.name || "PPM gateway",
        options: {
          baseURL,
          apiKey: `{file:${keyPath}}`,
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
  const path = join(dir, "opencode.json");
  await writePrivateJson(path, config);
  return {
    extends: "opencode",
    env: {
      PPM_OPENCODE_CONFIG: path,
      // Clear inline settings from older generations on Paseo's env deep merge.
      OPENCODE_CONFIG_CONTENT: "",
      PPM_GATEWAY_KEY: "",
    },
    models: modelChoices("opencode", models),
  };
}
