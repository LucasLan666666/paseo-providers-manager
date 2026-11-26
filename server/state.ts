import { randomUUID } from "node:crypto";
import type {
  AgentId,
  Binding,
  Connection,
  Model,
  Snapshot,
} from "../shared/contracts";
import {
  limitIssue,
  orderedSelection,
  resolveModel,
} from "../shared/limits";

export interface SavedConnection extends Connection {
  key: string;
}
export interface State {
  version: 2;
  owner: string;
  connections: SavedConnection[];
  bindings: Binding[];
}

/** The version-1 layout: limits per binding plus per-agent defaults. */
interface StateV1 {
  version: 1;
  owner: string;
  connections: SavedConnection[];
  bindings: Array<
    Binding & {
      overrides?: Record<string, { context?: { value: number; ack?: number }; output?: { value: number; ack?: number } }>;
    }
  >;
  defaults?: unknown;
}

export function initialState(): State {
  return { version: 2, owner: randomUUID(), connections: [], bindings: [] };
}

/**
 * Version 2 keeps limits on the connection, shared by its agents, and drops the
 * per-agent defaults (they were far above most models' real windows). Manual
 * values move from the bindings to their connection; when two agents disagree
 * the first binding wins.
 */
export function migrateState(raw: StateV1 | State): State {
  if (raw.version === 2) return raw;
  if (raw.version !== 1) throw new Error("此管理器数据版本无法读取。");
  // lastRefresh = null makes every connection stale, so the automatic refresh
  // on the next page open runs the models.dev name matching before the configs
  // are regenerated (without it they would start on the 128K / 16K fallback).
  const connections = raw.connections.map((connection) => ({ ...connection, lastRefresh: null }));
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const bindings: Binding[] = [];
  for (const { overrides, ...binding } of raw.bindings) {
    bindings.push(binding);
    const connection = byId.get(binding.connection);
    if (!connection || !overrides) continue;
    for (const [model, entry] of Object.entries(overrides)) {
      const setting = { ...(connection.settings?.[model] ?? {}) };
      if (entry.context && !setting.context) setting.context = entry.context;
      if (entry.output && !setting.output) setting.output = entry.output;
      if (Object.keys(setting).length)
        connection.settings = { ...(connection.settings ?? {}), [model]: setting };
    }
  }
  // v1 accepted outputs that relied on an agent default context, or that two
  // agents disagreed on. A migrated manual output that would now fill the
  // window is dropped; the automatic value (clamped) takes over.
  for (const connection of connections) {
    for (const [id, setting] of Object.entries(connection.settings ?? {})) {
      if (!setting.output) continue;
      const model = connection.models.find((m) => m.id === id) ?? { id, label: id, listed: false };
      if (limitIssue(resolveModel(connection, model))) {
        const { output: _dropped, ...rest } = setting;
        if (Object.keys(rest).length) connection.settings![id] = rest;
        else delete connection.settings![id];
      }
    }
  }
  return { version: 2, owner: raw.owner, connections, bindings };
}

export function findConnection(state: State, id: string) {
  const connection = state.connections.find((item) => item.id === id);
  if (!connection) throw new Error("找不到连接，请刷新管理页。");
  return connection;
}
export function getBinding(state: State, agent: AgentId, connection: string) {
  let binding = state.bindings.find(
    (item) => item.agent === agent && item.connection === connection,
  );
  if (!binding) {
    binding = { agent, connection, selected: [] };
    state.bindings.push(binding);
  }
  return binding;
}

export function mergeCatalog(
  connection: SavedConnection,
  models: Model[],
) {
  const previous = new Map(connection.models.map((model) => [model.id, model]));
  // The first catalog of a connection is not "new"; later additions are.
  const flagNew = connection.lastRefresh !== null && previous.size > 0;
  const result = new Map<string, Model>();
  for (const model of models) {
    if (Object.hasOwn(Object.prototype, model.id) || model.id === "prototype")
      throw new Error("目录包含无效模型 ID。");
    const before = previous.get(model.id);
    // A gateway may omit limits on a later refresh, and the optional catalog
    // enrichment can be unavailable. Keep the last known values instead of
    // forgetting what was already established.
    const merged: Model = { ...model };
    if (before) {
      if (merged.context === undefined && before.context) merged.context = before.context;
      if (merged.output === undefined && before.output) merged.output = before.output;
      if (merged.kind === undefined && before.kind) merged.kind = before.kind;
      if (merged.caps === undefined && before.caps) merged.caps = before.caps;
      if (merged.full === undefined && before.full && merged.context?.value === before.context?.value)
        merged.full = before.full;
      if (
        merged.suggested === undefined &&
        before.suggested &&
        (merged.context === undefined || merged.output === undefined)
      )
        merged.suggested = before.suggested;
      if (before.fresh) merged.fresh = true;
    } else if (flagNew) merged.fresh = true;
    result.set(model.id, merged);
    for (const field of ["context", "output"] as const) {
      if (before?.[field]?.value === merged[field]?.value) continue;
      const override = connection.settings?.[model.id]?.[field];
      if (override) delete override.ack;
    }
  }
  for (const [id, model] of previous) {
    if (!result.has(id)) result.set(id, { ...model, listed: false, fresh: undefined });
  }
  connection.models = [...result.values()];
  connection.lastRefresh = Date.now();
  connection.error = null;
}

/**
 * The models one binding generates, in picker order (default first). Limits and
 * capabilities come from the shared resolver; only a manual output that fills
 * the context window is rejected, automatic values never block generation.
 */
export function resolvedModels(state: State, binding: Binding) {
  const connection = findConnection(state, binding.connection);
  const catalogue = new Map(connection.models.map((model) => [model.id, model]));
  return orderedSelection(binding, connection).map((id) => {
    const model = catalogue.get(id);
    if (!model) throw new Error("所选模型已变化，请刷新列表。");
    const resolved = resolveModel(connection, model);
    const issue = limitIssue(resolved);
    if (issue)
      throw new Error(
        `${model.id} 的最大输出 ${issue.output} 必须小于上下文窗口 ${issue.context}，请修正手动值。`,
      );
    return {
      id,
      label: model.label,
      context: resolved.context.value,
      output: resolved.output.value,
      contextSource: resolved.context.source,
      outputSource: resolved.output.source,
      caps: resolved.caps,
      chat: resolved.chat,
    };
  });
}

export function snapshotOf(state: State, agents: Snapshot["agents"]): Snapshot {
  return {
    agents,
    bindings: state.bindings,
    connections: state.connections.map(
      ({ key: _key, ...publicFields }) => publicFields,
    ),
  };
}
