import type { AgentId } from "../shared/contracts";

export type ScreenView = "agents" | "library";
export type ScreenForm =
  | { kind: "create" }
  | { kind: "edit"; connectionId: string };

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
