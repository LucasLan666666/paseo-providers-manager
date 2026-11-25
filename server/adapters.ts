import type { AgentId } from "../shared/contracts";
import {
  pickerModelId,
  type AdapterConnection,
  type AdapterModel,
  type BuiltProvider,
} from "./adapter-common";
import { claudeProvider } from "./adapter-claude";
import { codexProvider } from "./adapter-codex";
import { copilotProvider } from "./adapter-copilot";
import { opencodeProvider } from "./adapter-opencode";
import { ompProvider, piProvider } from "./adapter-pi";
import { antigravityProvider } from "./adapter-antigravity";
import { museProvider } from "./adapter-muse";

export type { AdapterModel, AdapterConnection, BuiltProvider, ProviderModelChoice } from "./adapter-common";

export { pickerModelId };

/** Agents whose native CLI can be pointed at a custom gateway by this plugin. */
export type NativeAgentId = Exclude<AgentId, "fx" | "hoplite">;

/**
 * Build the Paseo custom-provider entry for one agent/connection generation.
 *
 * The returned object is spread into agents.providers[alias]. Every adapter
 * either writes a native config that only talks to this connection or throws;
 * an unsupported protocol is never redirected to another API.
 */
export async function buildProvider(
  agent: NativeAgentId,
  connection: AdapterConnection,
  models: Array<{ id: string; label: string; context?: number; output?: number }>,
  dir: string,
): Promise<BuiltProvider> {
  switch (agent) {
    case "claude":
      return claudeProvider(connection, models, dir);
    case "codex":
      return codexProvider(connection, models, dir);
    case "copilot":
      return copilotProvider(connection, models, dir);
    case "opencode":
      return opencodeProvider(connection, models, dir);
    case "pi":
      return piProvider(connection, models, dir);
    case "omp":
      return ompProvider(connection, models, dir);
    case "antigravity":
      return antigravityProvider(connection, models, dir);
    case "muse":
      return museProvider(connection, models, dir);
    default: {
      const exhaustive: never = agent;
      throw new Error(`未知 agent：${String(exhaustive)}`);
    }
  }
}
