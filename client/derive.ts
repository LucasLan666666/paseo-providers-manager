import type {
  AgentId,
  Binding,
  Capacity,
  Connection,
  Limits,
  Model,
  Override,
  Snapshot,
} from "../shared/contracts";
import { STALE_AFTER_MS } from "./format";

export type AgentDescriptor = Snapshot["agents"][number];
export type LimitField = "context" | "output";
export type LimitSource = "manual" | "gateway" | "catalog" | "default";

export interface ResolvedLimit {
  value?: number;
  source?: LimitSource;
  capacity?: Capacity;
  override?: Override;
}

export interface CapacityConflict {
  field: LimitField;
  manual: Override;
  automatic: number;
  acknowledged?: number;
}

export function agentDescriptor(snapshot: Snapshot, agent: AgentId): AgentDescriptor | undefined {
  return snapshot.agents.find((entry) => entry.id === agent);
}

export function connectionById(snapshot: Snapshot, id: string): Connection | undefined {
  return snapshot.connections.find((entry) => entry.id === id);
}

export function bindingFor(
  snapshot: Snapshot,
  agent: AgentId,
  connection: string,
): Binding | undefined {
  return snapshot.bindings.find((entry) => entry.agent === agent && entry.connection === connection);
}

export function bindingsForAgent(snapshot: Snapshot, agent: AgentId): Binding[] {
  return snapshot.bindings.filter((entry) => entry.agent === agent);
}

export function protocolSupported(agent: AgentDescriptor | undefined, connection: Connection): boolean {
  return agent?.protocols.includes(connection.protocol) ?? false;
}

export function availableConnections(
  snapshot: Snapshot,
  agent: AgentId,
): Connection[] {
  const descriptor = agentDescriptor(snapshot, agent);
  const bound = new Set(bindingsForAgent(snapshot, agent).map((entry) => entry.connection));
  return snapshot.connections.filter(
    (connection) => protocolSupported(descriptor, connection) && !bound.has(connection.id),
  );
}

/** Connections that cannot be used by this agent because of their protocol. */
export function incompatibleConnections(snapshot: Snapshot, agent: AgentId): Connection[] {
  const descriptor = agentDescriptor(snapshot, agent);
  const bound = new Set(bindingsForAgent(snapshot, agent).map((entry) => entry.connection));
  return snapshot.connections.filter(
    (connection) => !protocolSupported(descriptor, connection) && !bound.has(connection.id),
  );
}

export function agentsUsing(snapshot: Snapshot, connection: string): AgentId[] {
  return snapshot.bindings
    .filter((entry) => entry.connection === connection)
    .map((entry) => entry.agent);
}

export function modelById(connection: Connection | undefined, id: string): Model | undefined {
  return connection?.models.find((entry) => entry.id === id);
}

export function selectedModels(binding: Binding | undefined, connection: Connection | undefined): Model[] {
  if (!binding || !connection) return [];
  const byId = new Map(connection.models.map((model) => [model.id, model]));
  return binding.selected.map((id) => byId.get(id)).filter((model): model is Model => Boolean(model));
}

export function missingModelIds(binding: Binding | undefined, connection: Connection | undefined): string[] {
  if (!binding) return [];
  const known = new Set(connection?.models.map((model) => model.id) ?? []);
  return binding.selected.filter((id) => !known.has(id));
}

/** Selected models still present in the saved catalog but no longer returned by the gateway. */
export function unlistedSelectedModels(
  binding: Binding | undefined,
  connection: Connection | undefined,
): Model[] {
  return selectedModels(binding, connection).filter((model) => !model.listed);
}

/** Missing ids plus selected models the gateway no longer lists. */
export function missingSelectionCount(
  binding: Binding | undefined,
  connection: Connection | undefined,
): number {
  return missingModelIds(binding, connection).length + unlistedSelectedModels(binding, connection).length;
}

export function resolveLimit(
  binding: Binding | undefined,
  model: Model,
  field: LimitField,
  defaults: Limits | undefined,
): ResolvedLimit {
  const override = binding?.overrides[model.id]?.[field];
  if (override) return { value: override.value, source: "manual", override };
  const capacity = model[field];
  if (capacity) return { value: capacity.value, source: capacity.source, capacity };
  const fallback = defaults?.[field];
  if (fallback) return { value: fallback, source: "default" };
  return {};
}

export function conflictsFor(binding: Binding | undefined, model: Model): CapacityConflict[] {
  if (!binding) return [];
  const conflicts: CapacityConflict[] = [];
  for (const field of ["context", "output"] as const) {
    const manual = binding.overrides[model.id]?.[field];
    const automatic = model[field]?.value;
    if (!manual || automatic === undefined) continue;
    if (manual.value !== automatic && manual.ack !== automatic) {
      conflicts.push({
        field,
        manual,
        automatic,
        acknowledged: manual.ack,
      });
    }
  }
  return conflicts;
}

export function isStaleConnection(connection: Connection, now = Date.now()): boolean {
  if (connection.lastRefresh == null) return true;
  return now - connection.lastRefresh > STALE_AFTER_MS;
}

export interface AgentSummary {
  bound: number;
  selected: number;
  conflicts: number;
  missing: number;
  errors: number;
  issues: number;
}

export function agentSummary(snapshot: Snapshot, agent: AgentId, now = Date.now()): AgentSummary {
  const bindings = bindingsForAgent(snapshot, agent);
  let selected = 0;
  let conflicts = 0;
  let missing = 0;
  let errors = 0;
  for (const binding of bindings) {
    selected += binding.selected.length;
    const connection = connectionById(snapshot, binding.connection);
    if (!connection) {
      errors += 1;
      missing += binding.selected.length;
      continue;
    }
    if (connection.error) errors += 1;
    missing += missingSelectionCount(binding, connection);
    for (const id of binding.selected) {
      const model = modelById(connection, id);
      if (model) conflicts += conflictsFor(binding, model).length;
    }
  }
  return {
    bound: bindings.length,
    selected,
    conflicts,
    missing,
    errors,
    issues: conflicts + missing + errors,
  };
}
