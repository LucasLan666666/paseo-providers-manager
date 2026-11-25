import type { AgentId, Protocol } from "../shared/contracts";

export type ScreenView = "agents" | "library";

/** Prefilled values for the connection form (switch / copy flows). */
export interface FormPreset {
  protocol?: Protocol;
  name?: string;
  url?: string;
  catalogProvider?: string;
  /** Create a copy that reuses this connection's key (same origin only). */
  copyFrom?: string;
}

/**
 * `origin` is the agent whose page opened the form, if any. Only then does the
 * form talk about "this agent"; the top bar and the library have no agent.
 */
export type ScreenForm =
  | { kind: "create"; origin?: AgentId; preset?: FormPreset }
  | { kind: "edit"; connectionId: string; origin?: AgentId; preset?: FormPreset };

/**
 * Paseo may remount a plugin screen when the host window crosses the compact
 * breakpoint or changes theme. Keep the user's place in module memory so the
 * remounted screen resumes the same agent/view and open panel. This is
 * intentionally not persisted to storage: it lives only for this client
 * bundle's lifetime.
 */
export interface ScreenMemory {
  agentId: AgentId | null;
  view: ScreenView;
  modelConnectionId: string | null;
  form: ScreenForm | null;
}

let memory: ScreenMemory = {
  agentId: null,
  view: "agents",
  modelConnectionId: null,
  form: null,
};

export function readScreenMemory(): ScreenMemory {
  return { ...memory };
}

export function rememberAgent(agentId: AgentId): void {
  memory = { ...memory, agentId };
}

export function rememberView(view: ScreenView): void {
  memory = { ...memory, view };
}

export function rememberModelConnection(modelConnectionId: string | null): void {
  memory = { ...memory, modelConnectionId };
}

export function rememberForm(form: ScreenForm | null): void {
  memory = { ...memory, form };
}
