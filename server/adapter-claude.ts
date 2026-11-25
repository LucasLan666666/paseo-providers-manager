import {
  anthropicBase,
  assertModels,
  assertProtocol,
  childDir,
  ensurePrivateDir,
  modelChoices,
  type AdapterConnection,
  type AdapterModel,
  type BuiltProvider,
} from "./adapter-common";

/**
 * Claude Code is an Anthropic Messages client. Paseo passes the environment to
 * the Claude Agent SDK, so a private CLAUDE_CONFIG_DIR keeps sessions, settings
 * and legacy ~/.claude.json state out of the user's real Claude install.
 */
export async function claudeProvider(
  connection: AdapterConnection,
  models: readonly AdapterModel[],
  dir: string,
): Promise<BuiltProvider> {
  assertProtocol("Claude Code", connection.protocol, ["anthropic"]);
  assertModels(models);
  const configDir = await ensurePrivateDir(childDir(dir, "claude"));
  const first = models[0].id;
  return {
    extends: "claude",
    // Third-party Anthropic-compatible gateways rarely implement server-side WebSearch.
    disallowedTools: ["WebSearch"],
    env: {
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: anthropicBase(connection.url),
      // Claude Code needs a credential even for a local unauthenticated gateway.
      ANTHROPIC_AUTH_TOKEN: connection.key || "ppm-no-key",
      ANTHROPIC_MODEL: first,
      // Claude uses a small model for titles and other background work. Point it
      // at a model the gateway actually serves instead of Anthropic's haiku id.
      ANTHROPIC_SMALL_FAST_MODEL: first,
    },
    models: modelChoices("claude", models),
  };
}
