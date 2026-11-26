import { join } from "node:path";
import {
  anthropicBase,
  assertModels,
  assertProtocol,
  childDir,
  ensurePrivateDir,
  modelChoices,
  openAiBase,
  writePrivateJson,
  type AdapterConnection,
  type AdapterModel,
  type BuiltProvider,
} from "./adapter-common";

interface CopilotModel {
  id: string;
  provider: "ppm";
  name: string;
  maxPromptTokens?: number;
  maxContextWindowTokens?: number;
  maxOutputTokens?: number;
  capabilities: { supports: { toolCalls: boolean; streaming: true } };
}

/**
 * Copilot CLI's BYOK registry lives in $COPILOT_HOME/providers.json. The file
 * takes precedence over the legacy COPILOT_PROVIDER_* variables and supports
 * per-model context/output limits, so it is both the most capable path and the
 * one that keeps one generated directory per gateway.
 *
 * The registry stores credentials as plain text by design; the generated file is
 * created 0600 inside the private generation directory.
 */
export async function copilotProvider(
  connection: AdapterConnection,
  models: readonly AdapterModel[],
  dir: string,
): Promise<BuiltProvider> {
  assertProtocol("GitHub Copilot", connection.protocol, ["chat", "responses", "anthropic"]);
  assertModels(models);
  const home = await ensurePrivateDir(childDir(dir, "copilot"));
  const provider =
    connection.protocol === "anthropic"
      ? {
          name: "ppm",
          type: "anthropic" as const,
          baseUrl: anthropicBase(connection.url),
          ...(connection.key ? { apiKey: connection.key } : {}),
        }
      : {
          name: "ppm",
          type: "openai" as const,
          baseUrl: openAiBase(connection.url),
          wireApi: connection.protocol === "responses" ? ("responses" as const) : ("completions" as const),
          ...(connection.key ? { bearerToken: connection.key } : {}),
        };
  const registryModels: CopilotModel[] = models.map((model) => ({
    id: model.id,
    provider: "ppm",
    name: model.label.trim() || model.id,
    ...(model.context
      ? {
          maxContextWindowTokens: model.context,
          ...(model.output
            ? { maxPromptTokens: Math.max(1, model.context - model.output) }
            : {}),
        }
      : {}),
    ...(model.output ? { maxOutputTokens: model.output } : {}),
    capabilities: { supports: { toolCalls: model.caps?.tools ?? true, streaming: true } },
  }));
  await writePrivateJson(join(home, "providers.json"), {
    providers: [provider],
    models: registryModels,
  });
  return {
    extends: "copilot",
    env: {
      COPILOT_HOME: home,
      COPILOT_PROVIDERS_CONFIG: join(home, "providers.json"),
      COPILOT_MODEL: `ppm/${models[0].id}`,
    },
    models: modelChoices("copilot", models),
  };
}
