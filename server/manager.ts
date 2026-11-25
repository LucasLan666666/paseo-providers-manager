import type { PaseoApi } from "./types";
import { randomUUID } from "node:crypto";
import type { Action, Binding } from "../shared/contracts";
import { agents } from "./agents";
import { discover } from "./catalog";
import { preparePatch, pruneGenerations } from "./registry";
import { antigravityPickerId } from "./adapter-common";
import {
  findConnection,
  getBinding,
  mergeCatalog,
  snapshotOf,
  type SavedConnection,
  type State,
} from "./state";
import { Storage } from "./storage";

const DAY = 24 * 60 * 60 * 1000;

async function refresh(state: State, conn: SavedConnection) {
  try {
    mergeCatalog(state, conn, await discover(conn));
  } catch (error) {
    const message = error instanceof Error ? error.message : "目录请求失败";
    conn.error = conn.key
      ? message.replaceAll(conn.key, "••••").slice(0, 300)
      : message.slice(0, 300);
  }
}

function validateConnection(state: State, connection: SavedConnection) {
  const issues = new Set<string>();
  const bound = state.bindings.filter(
    (binding) => binding.connection === connection.id,
  );
  for (const model of connection.models) {
    const name =
      model.label && model.label !== model.id
        ? `${model.label} (${model.id})`
        : model.id;
    if (!model.listed) issues.add(`${name}：网关目录未列出`);
    for (const binding of bound) {
      const descriptor = agents.find((agent) => agent.id === binding.agent);
      if (!descriptor) continue;
      if (!descriptor.protocols.includes(connection.protocol)) {
        issues.add(
          `${descriptor.label} 不支持该连接的 ${connection.protocol} 协议`,
        );
        continue;
      }
      if (binding.agent === "antigravity" && antigravityPickerId(model.id) === undefined)
        issues.add(`${name}：无法映射到 agy 内置模型`);
      if (!binding.selected.includes(model.id)) continue;
      if (
        ["pi", "omp", "opencode"].includes(binding.agent) &&
        (!model.context || !model.output)
      )
        issues.add(
          `${name}：${descriptor.label} 需要上下文窗口和最大输出`,
        );
      if (
        ["pi", "omp", "opencode", "fx", "copilot"].includes(binding.agent) &&
        model.context &&
        model.output &&
        model.output.value >= model.context.value
      )
        issues.add(`${name}：最大输出必须小于上下文窗口`);
    }
  }
  return [...issues];
}

function applyOverride(
  conn: SavedConnection,
  binding: Binding,
  change: Pick<
    Extract<Action, { type: "override" }>,
    "model" | "field" | "value"
  >,
) {
  const model = conn.models.find((m) => m.id === change.model);
  if (!model) throw new Error("找不到对应模型。");

  const row = binding.overrides[model.id] ?? {};
  if (change.value === null) delete row[change.field];
  else
    row[change.field] = {
      value: change.value,
      ack: model[change.field]?.value,
    };
  if (Object.keys(row).length) binding.overrides[model.id] = row;
  else delete binding.overrides[model.id];
}

export class Manager {
  private queue = Promise.resolve();
  private storage: Storage;
  private committed?: State;
  constructor(root: string) {
    this.storage = new Storage(root);
  }

  // Serialize both aliases and state across all clients of this installation.
  private serial<T>(fn: () => Promise<T>) {
    const result = this.queue.then(fn);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  snapshot(paseo: PaseoApi) {
    if (this.committed)
      return Promise.resolve(snapshotOf(this.committed, agents));
    return this.serial(async () => {
      this.committed = await this.storage.load(paseo);
      return snapshotOf(this.committed, agents);
    });
  }
  action(action: Action, paseo: PaseoApi) {
    return this.serial(async () => {
      const current = await this.storage.load(paseo);
      this.committed = current;
      const next = structuredClone(current);
      let message = "已保存";
      switch (action.type) {
        case "testConnection": {
          const conn = findConnection(next, action.connection);
          await refresh(next, conn);
          if (conn.error) {
            message = conn.error;
            break;
          }
          const issues = validateConnection(next, conn);
          if (conn.models.length === 0)
            message = "目录没有模型，请检查网关的模型列表。";
          else if (issues.length === 0)
            message = `已检查 ${conn.models.length} 个模型，全部通过。`;
          else
            message =
              `已检查 ${conn.models.length} 个模型，发现 ${issues.length} 个问题：\n` +
              issues.slice(0, 8).join("\n") +
              (issues.length > 8 ? `\n…另有 ${issues.length - 8} 个问题` : "");
          break;
        }
        case "saveConnection": {
          const url = new URL(action.url);
          if (url.username || url.password || url.hash || url.search)
            throw new Error("网关地址不能包含凭据、查询参数或片段。");
          const name = action.name.trim();
          if (!name) throw new Error("请输入连接名称。");
          const conn: SavedConnection = action.id
            ? findConnection(next, action.id)
            : {
                id: randomUUID(),
                name,
                url: action.url,
                protocol: action.protocol,
                catalogProvider: "",
                hasKey: false,
                key: "",
                lastRefresh: null,
                error: null,
                models: [],
              };
          if (
            action.id &&
            conn.key &&
            new URL(conn.url).origin !== url.origin &&
            !action.key
          ) {
            throw new Error("网关域名或端口变更，请为新地址重新输入 Key。");
          }
          if (
            conn.protocol !== action.protocol &&
            next.bindings.some(
              (b) => b.connection === conn.id && b.selected.length,
            )
          )
            throw new Error("请先停用使用该连接的模型，再切换协议。");
          Object.assign(conn, {
            name,
            url: action.url.replace(/\/+$/, ""),
            protocol: action.protocol,
            catalogProvider: action.catalogProvider,
            key: action.key ?? conn.key,
          });
          conn.hasKey = !!conn.key;
          if (!action.id) next.connections.push(conn);
          await refresh(next, conn);
          message = conn.error
            ? "连接已保存，目录加载失败：" + conn.error
            : "连接已保存，模型目录已更新。";
          break;
        }
        case "deleteConnection":
          findConnection(next, action.connection);
          next.connections = next.connections.filter(
            (c) => c.id !== action.connection,
          );
          next.bindings = next.bindings.filter(
            (b) => b.connection !== action.connection,
          );
          break;
        case "refresh": {
          const conn = findConnection(next, action.connection);
          await refresh(next, conn);
          message =
            conn.error ??
            `已拉取 ${conn.models.filter((m) => m.listed).length} 个模型。`;
          break;
        }
        case "refreshStale": {
          const stale = next.connections.filter(
            (c) => !c.lastRefresh || Date.now() - c.lastRefresh >= DAY,
          );
          if (!stale.length) return { message: "目录已是最新" };
          await Promise.all(stale.map((c) => refresh(next, c)));
          message = `已检查 ${stale.length} 个连接，失败 ${stale.filter((c) => c.error).length} 个。`;
          break;
        }
        case "defaults":
          if (action.context === undefined && action.output === undefined)
            delete next.defaults[action.agent];
          else
            next.defaults[action.agent] = {
              context: action.context,
              output: action.output,
            };
          break;
        case "selection":
          findConnection(next, action.connection);
          getBinding(next, action.agent, action.connection).selected = [
            ...new Set(action.selected),
          ];
          for (const change of action.changes ?? [])
            applyOverride(
              findConnection(next, action.connection),
              getBinding(next, action.agent, action.connection),
              change,
            );
          break;
        case "override": {
          applyOverride(
            findConnection(next, action.connection),
            getBinding(next, action.agent, action.connection),
            action,
          );
          break;
        }
      }
      const patch = await preparePatch(this.storage.root, current, next, paseo);
      await this.storage.commit(next, patch, paseo);
      this.committed = next;
      await pruneGenerations(this.storage.root, paseo).catch(() => {});
      if (
        action.type === "refresh" &&
        findConnection(next, action.connection).error
      )
        throw new Error(message);
      if (action.type === "testConnection") {
        const conn = findConnection(next, action.connection);
        if (conn.error) throw new Error(conn.error);
      }
      return { message };
    });
  }
}
