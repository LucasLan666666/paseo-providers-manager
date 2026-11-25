import { randomUUID } from "node:crypto";
import type {
  AgentId,
  Binding,
  Connection,
  Limits,
  Model,
  Snapshot,
} from "../shared/contracts";

export interface SavedConnection extends Connection {
  key: string;
}
export interface State {
  version: 1;
  owner: string;
  connections: SavedConnection[];
  bindings: Binding[];
  defaults: Snapshot["defaults"];
}
export function initialState(): State {
  return {
    version: 1,
    owner: randomUUID(),
    connections: [],
    bindings: [],
    defaults: {},
  };
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
    binding = { agent, connection, selected: [], overrides: {} };
    state.bindings.push(binding);
  }
  return binding;
}
export function mergeCatalog(
  state: State,
  connection: SavedConnection,
  models: Model[],
) {
  const previous = new Map(connection.models.map((model) => [model.id, model]));
  const result = new Map<string, Model>();
  for (const model of models) {
    if (Object.hasOwn(Object.prototype, model.id) || model.id === "prototype")
      throw new Error("目录包含无效模型 ID。");
    const before = previous.get(model.id);
    // A gateway may omit limits on a later refresh, and the optional catalog
    // enrichment can be unavailable. Keep the last known value instead of
    // forgetting a limit that was already established.
    const merged: Model = before
      ? {
          ...model,
          ...(model.context === undefined && before.context
            ? { context: before.context }
            : {}),
          ...(model.output === undefined && before.output
            ? { output: before.output }
            : {}),
        }
      : model;
    result.set(model.id, merged);
    for (const field of ["context", "output"] as const) {
      if (before?.[field]?.value === merged[field]?.value) continue;
      for (const binding of state.bindings) {
        const override =
          binding.connection === connection.id &&
          binding.overrides[model.id]?.[field];
        if (override) delete override.ack;
      }
    }
  }
  for (const [id, model] of previous) {
    if (!result.has(id)) result.set(id, { ...model, listed: false });
  }
  connection.models = [...result.values()];
  connection.lastRefresh = Date.now();
  connection.error = null;
}
export function resolvedModels(state: State, binding: Binding) {
  const connection = findConnection(state, binding.connection);
  const catalogue = new Map(
    connection.models.map((model) => [model.id, model]),
  );
  return binding.selected.map((id) => {
    const model = catalogue.get(id);
    if (!model) throw new Error("所选模型已变化，请刷新列表。");
    const limits: Limits = {};
    for (const field of ["context", "output"] as const) {
      limits[field] =
        binding.overrides[id]?.[field]?.value ??
        model[field]?.value ??
        state.defaults[binding.agent]?.[field];
    }
    if (
      ["pi", "omp", "opencode"].includes(binding.agent) &&
      (!limits.context || !limits.output)
    ) {
      throw new Error(
        `${model.id} 缺少上下文窗口或最大输出，请填写模型参数或 agent 默认值后启用。`,
      );
    }
    if (
      ["pi", "omp", "opencode", "fx", "copilot"].includes(binding.agent) &&
      limits.context &&
      limits.output &&
      limits.output >= limits.context
    ) {
      throw new Error(
        `${model.id} 的最大输出必须小于上下文窗口，请修正模型参数。`,
      );
    }
    return { id, label: model.label, ...limits };
  });
}
export function snapshotOf(state: State, agents: Snapshot["agents"]): Snapshot {
  return {
    agents,
    defaults: state.defaults,
    bindings: state.bindings,
    connections: state.connections.map(
      ({ key: _key, ...publicFields }) => publicFields,
    ),
  };
}
