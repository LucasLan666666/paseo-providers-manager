import {
  anthropicBase,
  assertModels,
  assertProtocol,
  modelChoices,
  type AdapterConnection,
  type AdapterModel,
  type BuiltProvider,
} from "./adapter-common";

/** Claude Code has its own table for its models; ids outside it count as unknown. */
export const claudeKnowsModel = (id: string) => /^claude-/i.test(id);

const minimum = (values: number[]) => (values.length ? String(Math.min(...values)) : "");

/**
 * Claude Code is an Anthropic Messages client. The gateway is selected only
 * through environment variables, exactly like Paseo's built-in Claude provider:
 * CLAUDE_CONFIG_DIR is left alone, so sessions use the user's real ~/.claude
 * (skills, plugins, session history, project memory) and ~/.claude.json.
 * Earlier versions pointed it at a private per-generation directory, which hid
 * all of that and lost history whenever the configuration changed.
 */
export async function claudeProvider(
  connection: AdapterConnection,
  models: readonly AdapterModel[],
  _dir: string,
): Promise<BuiltProvider> {
  assertProtocol("Claude Code", connection.protocol, ["anthropic"]);
  assertModels(models);
  const first = models[0].id;
  // Claude Code reads one value per process, not per model, so the smallest
  // relevant value is used. CLAUDE_CODE_MAX_CONTEXT_TOKENS only applies to
  // models it doesn't know; the output limit applies to all (capped at each
  // model's own maximum). Known models without a manual value keep Claude
  // Code's own numbers. An empty value means "unset" to Claude Code and also
  // clears a value an earlier generation wrote (provider env is deep-merged).
  const chat = models.filter((model) => model.chat !== false);
  const unknown = chat.filter((model) => !claudeKnowsModel(model.id));
  const contexts = unknown.map((model) => model.context).filter((v): v is number => !!v);
  const outputs = chat
    .filter((model) => !claudeKnowsModel(model.id) || model.outputSource === "manual")
    .map((model) => model.output)
    .filter((v): v is number => !!v);
  return {
    extends: "claude",
    // Third-party Anthropic-compatible gateways rarely implement server-side WebSearch.
    disallowedTools: ["WebSearch"],
    env: {
      ANTHROPIC_BASE_URL: anthropicBase(connection.url),
      // Claude Code needs a credential even for a local unauthenticated gateway.
      ANTHROPIC_AUTH_TOKEN: connection.key || "ppm-no-key",
      ANTHROPIC_MODEL: first,
      // Claude uses a small model for titles and other background work. Point it
      // at a model the gateway actually serves instead of Anthropic's haiku id.
      ANTHROPIC_SMALL_FAST_MODEL: first,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: minimum(contexts),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: minimum(outputs),
    },
    models: modelChoices("claude", models),
  };
}
