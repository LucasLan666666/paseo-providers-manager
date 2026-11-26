import type { PaseoApi } from "./types";
import { randomUUID } from "node:crypto";
import type { Action, Operation, SettingChange } from "../shared/contracts";
import { limitIssue, resolveModel } from "../shared/limits";
import { protocolInfo } from "../shared/protocols";
import { agents } from "./agents";
import { discover, fetchCatalog } from "./catalog";
import { enrichModels } from "./match";
import { probeModels } from "./probe";
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

const KIND_LABELS: Record<string, string> = {
  embedding: "嵌入模型",
  reranking: "重排模型",
  image: "图像模型",
  audio: "语音模型",
  video: "视频模型",
  other: "非对话模型",
};

async function refresh(conn: SavedConnection) {
  try {
    const models = await discover(conn);
    // Name matching across models.dev fills what the gateway and an exact
    // provider match left open, plus capabilities and the model kind.
    const catalog = await fetchCatalog();
    if (catalog) enrichModels(models, catalog, { provider: conn.catalogProvider || undefined });
    mergeCatalog(conn, models);
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
    for (const binding of bound) {
      const descriptor = agents.find((agent) => agent.id === binding.agent);
      if (!descriptor) continue;
      if (!descriptor.protocols.includes(connection.protocol)) {
        issues.add(
          `${descriptor.label} 不支持该连接的 ${protocolInfo[connection.protocol].label} 协议`,
        );
        continue;
      }
      if (!binding.selected.includes(model.id)) continue;
      if (!model.listed) issues.add(`${name}：网关目录未列出`);
      if (binding.agent === "antigravity" && antigravityPickerId(model.id) === undefined)
        issues.add(`${name}：无法映射到 agy 内置模型`);
      const resolved = resolveModel(connection, model);
      if (!resolved.chat)
        issues.add(`${name}：${KIND_LABELS[model.kind ?? "other"]}，不能用于对话`);
      const issue = limitIssue(resolved);
      if (issue)
        issues.add(`${name}：最大输出 ${issue.output} 必须小于上下文窗口 ${issue.context}`);
    }
  }
  return [...issues];
}

/** Apply manual limit/capability changes to the connection's shared settings. */
function applyChanges(conn: SavedConnection, changes: readonly SettingChange[]) {
  for (const change of changes) {
    const model = conn.models.find((m) => m.id === change.model);
    if (!model) throw new Error("找不到对应模型。");
    const row = { ...(conn.settings?.[model.id] ?? {}) };
    if (change.value === null) delete row[change.field];
    else if (typeof change.value === "number") {
      const field = change.field as "context" | "output";
      const automatic = model[field]?.value;
      row[field] = automatic === undefined ? { value: change.value } : { value: change.value, ack: automatic };
    } else row[change.field as "reasoning" | "image" | "tools"] = change.value;
    const settings = { ...(conn.settings ?? {}) };
    if (Object.keys(row).length) settings[model.id] = row;
    else delete settings[model.id];
    conn.settings = Object.keys(settings).length ? settings : undefined;
  }
  // A manual output must stay below the context the model will really use.
  for (const change of changes) {
    if (change.field !== "context" && change.field !== "output") continue;
    const model = conn.models.find((m) => m.id === change.model)!;
    const issue = limitIssue(resolveModel(conn, model));
    if (issue)
      throw new Error(
        `${model.id} 的最大输出 ${issue.output} 必须小于上下文窗口 ${issue.context}。`,
      );
  }
}

function setFallback(conn: SavedConnection, context?: number, output?: number) {
  if (context !== undefined && output !== undefined && output >= context)
    throw new Error("兜底的最大输出必须小于兜底上下文窗口。");
  conn.fallback =
    context === undefined && output === undefined ? undefined : { context, output };
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

  /**
   * Real requests can take a while; send them outside the serial queue so other
   * actions are not blocked, then record the results in a short commit.
   */
  private async probe(action: Extract<Action, { type: "probe" }>, paseo: PaseoApi) {
    const state = await this.serial(() => this.storage.load(paseo));
    const conn = findConnection(state, action.connection);
    const results = await probeModels(conn, action.models);
    return this.serial(async (): Promise<Omit<Operation, "job">> => {
      const current = await this.storage.load(paseo);
      const next = structuredClone(current);
      const target = findConnection(next, action.connection);
      target.probes = { ...(target.probes ?? {}), ...results };
      await this.storage.commit(next, null, paseo);
      this.committed = next;
      const failed = Object.values(results).filter((result) => !result.ok).length;
      const total = Object.keys(results).length;
      return failed
        ? { message: `已测试 ${total} 个模型：${total - failed} 个可用，${failed} 个失败。`, level: "warning" }
        : { message: `已测试 ${total} 个模型，全部可用。` };
    });
  }

  action(action: Action, paseo: PaseoApi) {
    if (action.type === "probe") return this.probe(action, paseo);
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
          await refresh(conn);
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
          await refresh(conn);
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
          await refresh(conn);
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
          await Promise.all(stale.map((c) => refresh(c)));
          const failed = stale.filter((c) => c.error).length;
          message = `已检查 ${stale.length} 个连接，失败 ${failed} 个。`;
          if (failed) level = "warning";
          break;
        }
        case "selection": {
          const conn = findConnection(next, action.connection);
          if (action.fallback) setFallback(conn, action.fallback.context, action.fallback.output);
          applyChanges(conn, action.changes ?? []);
          const selected = [...new Set(action.selected)];
          const targets = [action.agent, ...(action.alsoApply ?? []).filter((a) => a !== action.agent)];
          for (const agentId of targets) {
            const descriptor = agents.find((a) => a.id === agentId);
            if (!descriptor?.protocols.includes(conn.protocol))
              throw new Error(`${descriptor?.label ?? agentId} 不支持此连接的协议。`);
            const binding = getBinding(next, agentId, conn.id);
            binding.selected = [...selected];
            if (action.default !== undefined) {
              if (action.default === null || !selected.includes(action.default)) delete binding.default;
              else binding.default = action.default;
            } else if (binding.default && !selected.includes(binding.default)) delete binding.default;
          }
          if (targets.length > 1) message = `已更新 ${targets.length} 个 Agent 的模型配置`;
          break;
        }
        case "settings":
          applyChanges(findConnection(next, action.connection), action.changes);
          break;
        case "fallback":
          setFallback(findConnection(next, action.connection), action.context, action.output);
          break;
        case "acceptSuggestions": {
          const conn = findConnection(next, action.connection);
          const wanted = action.models ? new Set(action.models) : undefined;
          const changes: SettingChange[] = [];
          for (const model of conn.models) {
            if (wanted && !wanted.has(model.id)) continue;
            const suggestion = model.suggested;
            if (!suggestion) continue;
            const setting = conn.settings?.[model.id];
            if (suggestion.context && !model.context && !setting?.context)
              changes.push({ model: model.id, field: "context", value: suggestion.context });
            if (suggestion.output && !model.output && !setting?.output)
              changes.push({ model: model.id, field: "output", value: suggestion.output });
          }
          applyChanges(conn, changes);
          message = changes.length ? `已采用 ${changes.length} 个推荐值。` : "没有待确认的推荐值。";
          break;
        }
        case "markSeen": {
          const conn = findConnection(next, action.connection);
          for (const model of conn.models) delete model.fresh;
          break;
        }
      }
      let patch: Awaited<ReturnType<typeof preparePatch>>;
      try {
        patch = await preparePatch(this.storage.root, current, next, paseo);
      } catch (error) {
        // The refreshed catalog can make a selected model unusable. A test
        // should list that problem instead of failing with one raw error; the
        // refreshed catalog is not saved, so the working configuration stays.
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
