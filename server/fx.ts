import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Limits } from "../shared/contracts";
import type { SavedConnection } from "./state";
import { openAiBase } from "./adapter-common";

export async function fxProvider(
  connection: SavedConnection,
  models: Array<{ id: string; label: string } & Limits>,
  dir: string,
) {
  const transport = {
    chat: "openai-chat-completions",
    responses: "openai-responses",
    anthropic: "anthropic-messages",
  } as const;
  if (connection.protocol === "gemini")
    throw new Error(
      "fx 需要 Chat Completions、Responses 或 Anthropic Messages 网关。",
    );
  const settings = {
    provider: "managed",
    models: { managed: models[0].id },
    providers: {
      managed: {
        protocol: transport[connection.protocol],
        // Same base as discovery and the other adapters: a host-root OpenAI
        // URL means {host}/v1. Anthropic bases are passed through unchanged.
        base_url:
          connection.protocol === "anthropic" ? connection.url : openAiBase(connection.url),
        auth: connection.key
          ? { type: "bearer", env: "PPM_GATEWAY_KEY" }
          : { type: "none" },
        model_metadata: Object.fromEntries(
          models.map((model) => [
            model.id,
            {
              context_window: model.context,
              max_output_tokens: model.output,
            },
          ]),
        ),
      },
    },
  };
  const data = JSON.stringify(settings);
  if (Buffer.byteLength(data) > 65536)
    throw new Error("fx 配置超过其 64 KiB 上限，请减少启用的模型。");
  await writeFile(join(dir, "settings.json"), data, { mode: 0o600 });
  return {
    extends: "acp",
    command: ["fx", "acp"],
    env: {
      FX_HOME: dir,
      FX_PROVIDER: "managed",
      PPM_GATEWAY_KEY: connection.key,
    },
    models: models.map(({ id, label }, index) => ({
      id,
      label,
      isDefault: index === 0,
    })),
  };
}
