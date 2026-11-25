import { join } from "node:path";
import {
  anthropicBase,
  assertModels,
  assertProtocol,
  childDir,
  ensurePrivateDir,
  modelChoices,
  openAiBase,
  requireLimits,
  writePrivateJson,
  type AdapterConnection,
  type AdapterModel,
  type BuiltProvider,
} from "./adapter-common";

const PROVIDER = "ppm";

function apiFor(protocol: AdapterConnection["protocol"]): string {
  if (protocol === "chat") return "openai-completions";
  if (protocol === "responses") return "openai-responses";
  return "anthropic-messages";
}

function piModels(
  connection: AdapterConnection,
  models: readonly AdapterModel[],
  literalKey: boolean,
) {
  const baseUrl =
    connection.protocol === "anthropic"
      ? anthropicBase(connection.url)
      : openAiBase(connection.url);
  return {
    $schema: "https://pi.dev/schemas/models.schema.json",
    providers: {
      [PROVIDER]: {
        name: connection.name || "PPM gateway",
        baseUrl,
        apiKey: literalKey ? connection.key || "ppm-no-key" : "$PPM_GATEWAY_KEY",
        api: apiFor(connection.protocol),
        models: models.map((model) => ({
          id: model.id,
          name: model.label.trim() || model.id,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: model.context,
          maxTokens: model.output,
        })),
      },
    },
  };
}

/**
 * Pi and OMP are Pi-RPC compatible: both load `models.json` from the agent
 * directory and expose model ids as provider/id. Limit values are native
 * contextWindow / maxTokens fields. The agent directory, sessions and caches
 * are all private to this generation.
 *
 * OMP 19.1.0 does not interpolate "$VAR" in models.json (it forwards the literal
 * string as the bearer token), so its generated file carries the key directly.
 */
export async function piProvider(
  connection: AdapterConnection,
  models: readonly AdapterModel[],
  dir: string,
): Promise<BuiltProvider> {
  assertProtocol("Pi", connection.protocol, ["chat", "responses", "anthropic"]);
  assertModels(models);
  const limited = requireLimits("Pi", models);
  const agentDir = await ensurePrivateDir(childDir(dir, "pi-agent"));
  await ensurePrivateDir(join(agentDir, "sessions"));
  await writePrivateJson(join(agentDir, "models.json"), piModels(connection, limited, false));
  return {
    extends: "pi",
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
      PI_SKIP_VERSION_CHECK: "1",
      // Always present so a removed key cannot survive a provider-env merge.
      // The dummy keeps Pi from falling back to an unrelated ambient credential
      // when the gateway genuinely needs no auth.
      PPM_GATEWAY_KEY: connection.key || "ppm-no-key",
    },
    models: modelChoices("pi", models),
  };
}

export async function ompProvider(
  connection: AdapterConnection,
  models: readonly AdapterModel[],
  dir: string,
): Promise<BuiltProvider> {
  assertProtocol("Oh My Pi", connection.protocol, ["chat", "responses", "anthropic"]);
  assertModels(models);
  const limited = requireLimits("Oh My Pi", models);
  const home = await ensurePrivateDir(childDir(dir, "omp"));
  const agentDir = await ensurePrivateDir(join(home, "agent"));
  const dataRoot = await ensurePrivateDir(join(home, "data"));
  const stateRoot = await ensurePrivateDir(join(home, "state"));
  const cacheRoot = await ensurePrivateDir(join(home, "cache"));
  await writePrivateJson(join(agentDir, "models.json"), piModels(connection, limited, true));
  return {
    extends: "omp",
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      // Keep the user's OMP profile out of this provider; the generated agent dir
      // is only honoured for the default profile.
      OMP_PROFILE: "default",
      PI_PROFILE: "default",
      XDG_DATA_HOME: dataRoot,
      XDG_STATE_HOME: stateRoot,
      XDG_CACHE_HOME: cacheRoot,
    },
    models: modelChoices("omp", models),
  };
}
