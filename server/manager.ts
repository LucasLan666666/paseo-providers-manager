import type { PaseoApi } from "./types";
import { randomUUID } from "node:crypto";
import type { Action, Binding, Operation } from "../shared/contracts";
import { protocolInfo } from "../shared/protocols";
import { agents } from "./agents";
import { discover } from "./catalog";
import { preparePatch, pruneGenerations } from "./registry";
import { antigravityPickerId } from "./adapter-common";
import {
  effectiveLimits,
  findConnection,
  getBinding,
  limitProblem,
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

export function validateConnection(state: State, connection: SavedConnection) {
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
          `${descriptor.label} 不支持该连接的 ${protocolInfo[connection.protocol].label} 协议`,
        );
        continue;
      }
      if (binding.agent === "antigravity" && antigravityPickerId(model.id) === undefined)
        issues.add(`${name}：无法映射到 agy 内置模型`);
      if (!binding.selected.includes(model.id)) continue;
      // Check the limits the generated config really uses (manual value →
      // gateway/catalog → agent default), not only the catalog values.
      const limits = effectiveLimits(state, binding, model);
      const problem = limitProblem(binding.agent, limits);
      if (problem === "missing")
        issues.add(
          `${name}：${descriptor.label} 需要上下文窗口和最大输出（网关和目录没有提供，也没有手动值或 ${descriptor.label} 默认值）`,
        );
      if (problem === "order")
        issues.add(
          `${name}：${descriptor.label} 的最大输出 ${limits.output} 必须小于上下文窗口 ${limits.context}`,
        );
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
    return this.serial(async (): Promise<Omit<Operation, "job">> => {
      const current = await this.storage.load(paseo);
      this.committed = current;
      const next = structuredClone(current);
      let message = "已保存";
      let level: Operation["level"];
      let savedConnection: string | undefined;
      let testIssues = false;
      switch (action.type) {
        case "testConnection": {
          const conn = findConnection(next, action.connection);
          await refresh(next, conn);
          if (conn.error) {
            message = conn.error;
            break;
          }
          const issues = validateConnection(next, conn);
          if (conn.models.length === 0) {
            message = "目录没有模型，请检查网关的模型列表。";
            level = "warning";
          } else if (issues.length === 0)
            message = `已检查 ${conn.models.length} 个模型，全部通过。`;
          else {
            testIssues = true;
            message =
              `已检查 ${conn.models.length} 个模型，发现 ${issues.length} 个问题：\n` +
              issues.slice(0, 8).join("\n") +
              (issues.length > 8 ? `\n…另有 ${issues.length - 8} 个问题` : "");
            level = "warning";
          }
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
          // A copied connection may reuse the source key, but only for the same
          // origin: the key must never be sent to a host it was not saved for.
          let copiedKey: string | undefined;
          if (!action.id && action.copyKeyFrom && !action.key) {
            const source = findConnection(next, action.copyKeyFrom);
            if (new URL(source.url).origin !== url.origin)
              throw new Error("复制的连接更换了域名或端口，请重新输入 Key。");
            copiedKey = source.key;
          }
          if (
            conn.protocol !== action.protocol &&
            next.bindings.some(
              (b) => b.connection === conn.id && b.selected.length,
            )
          )
            throw new Error("请先停用使用该连接的模型，再切换协议。");
          const protocolChanged = action.id !== undefined && conn.protocol !== action.protocol;
          Object.assign(conn, {
            name,
            url: action.url.replace(/\/+$/, ""),
            protocol: action.protocol,
            catalogProvider: action.catalogProvider,
            // A copy with a blank key field uses the source key.
            key: action.key ? action.key : copiedKey ?? action.key ?? conn.key,
          });
          conn.hasKey = !!conn.key;
          if (!action.id) next.connections.push(conn);
          // Bindings left on this connection have no selected models (the guard
          // above). Drop the ones whose agent cannot use the new protocol, so
          // they don't linger as an incompatible card on that agent's page.
          if (protocolChanged)
            next.bindings = next.bindings.filter(
              (b) =>
                b.connection !== conn.id ||
                agents.find((a) => a.id === b.agent)?.protocols.includes(conn.protocol),
            );
          savedConnection = conn.id;
          await refresh(next, conn);
          if (conn.error) {
            message = "连接已保存，目录加载失败：" + conn.error;
            level = "warning";
          } else message = "连接已保存，模型目录已更新。";
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
          const failed = stale.filter((c) => c.error).length;
          message = `已检查 ${stale.length} 个连接，失败 ${failed} 个。`;
          if (failed) level = "warning";
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
      let patch: Awaited<ReturnType<typeof preparePatch>>;
      try {
        patch = await preparePatch(this.storage.root, current, next, paseo);
      } catch (error) {
        // The refreshed catalog can make a selected model unusable (for example
        // the gateway now reports output >= context). A test should list that
        // problem instead of failing with one raw error; the refreshed catalog
        // is not saved, so the working configuration stays in place.
        if (action.type === "testConnection" && testIssues)
          return {
            message: `${message}\n（因存在以上问题，本次获取的目录未保存，现有配置保持不变。）`,
            level: "warning",
          };
        throw error;
      }
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
      return {
        message,
        ...(level ? { level } : {}),
        ...(savedConnection ? { connection: savedConnection } : {}),
      };
    });
  }
}
