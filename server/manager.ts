import type { PaseoApi } from "./types";
import { randomUUID } from "node:crypto";
import type { Action, Operation, SettingChange } from "../shared/contracts";
import { limitIssue, resolveModel } from "../shared/limits";
import { protocolInfo } from "../shared/protocols";
import { agents, localizedAgents } from "./agents";
import { CatalogError, discover, fetchCatalog } from "./catalog";
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
import { count, L } from "./i18n";

const DAY = 24 * 60 * 60 * 1000;

function kindLabel(kind: string | undefined): string {
  switch (kind) {
    case "embedding":
      return L("嵌入模型", "an embedding model");
    case "reranking":
      return L("重排模型", "a reranking model");
    case "image":
      return L("图像模型", "an image model");
    case "audio":
      return L("语音模型", "an audio model");
    case "video":
      return L("视频模型", "a video model");
    default:
      return L("非对话模型", "not a chat model");
  }
}

async function refresh(conn: SavedConnection) {
  delete conn.errorTexts;
  try {
    const models = await discover(conn);
    // Name matching across models.dev fills what the gateway and an exact
    // provider match left open, plus capabilities and the model kind.
    const catalog = await fetchCatalog();
    if (catalog) enrichModels(models, catalog, { provider: conn.catalogProvider || undefined });
    mergeCatalog(conn, models);
  } catch (error) {
    const message = error instanceof Error ? error.message : L("目录请求失败", "Model list request failed");
    const redact = (text: string) => (conn.key ? text.replaceAll(conn.key, "••••") : text).slice(0, 300);
    conn.error = redact(message);
    // Keep both languages so a reader in the other language sees it translated.
    if (error instanceof CatalogError)
      conn.errorTexts = { zh: redact(error.texts.zh), en: redact(error.texts.en) };
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
          L(
            `${descriptor.label} 不支持该连接的 ${protocolInfo[connection.protocol].label} 协议`,
            `${descriptor.label} does not support this connection's ${protocolInfo[connection.protocol].label} protocol`,
          ),
        );
        continue;
      }
      if (!binding.selected.includes(model.id)) continue;
      if (!model.listed) issues.add(L(`${name}：网关目录未列出`, `${name}: no longer listed by the gateway`));
      if (binding.agent === "antigravity" && antigravityPickerId(model.id) === undefined)
        issues.add(L(`${name}：无法映射到 agy 内置模型`, `${name}: cannot be mapped to an agy built-in model`));
      const resolved = resolveModel(connection, model);
      if (!resolved.chat)
        issues.add(
          L(
            `${name}：${kindLabel(model.kind)}，不能用于对话`,
            `${name}: ${kindLabel(model.kind)}, cannot be used for chat`,
          ),
        );
      const issue = limitIssue(resolved);
      if (issue)
        issues.add(
          L(
            `${name}：最大输出 ${issue.output} 必须小于上下文窗口 ${issue.context}`,
            `${name}: max output ${issue.output} must be smaller than the context window ${issue.context}`,
          ),
        );
    }
  }
  return [...issues];
}

/** Apply manual limit/capability changes to the connection's shared settings. */
function applyChanges(conn: SavedConnection, changes: readonly SettingChange[]) {
  for (const change of changes) {
    const model = conn.models.find((m) => m.id === change.model);
    if (!model) throw new Error(L("找不到对应模型。", "Model not found."));
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
        L(
          `${model.id} 的最大输出 ${issue.output} 必须小于上下文窗口 ${issue.context}。`,
          `${model.id}: max output ${issue.output} must be smaller than the context window ${issue.context}.`,
        ),
      );
  }
}

function setFallback(conn: SavedConnection, context?: number, output?: number) {
  if (context !== undefined && output !== undefined && output >= context)
    throw new Error(
      L("兜底的最大输出必须小于兜底上下文窗口。", "The fallback max output must be smaller than the fallback context window."),
    );
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
      return Promise.resolve(snapshotOf(this.committed, localizedAgents()));
    return this.serial(async () => {
      this.committed = await this.storage.load(paseo);
      return snapshotOf(this.committed, localizedAgents());
    });
  }

  /**
   * Real requests can take a while; send them outside the serial queue so other
   * actions are not blocked, then record the results in a short commit.
   */
  private async probe(action: Extract<Action, { type: "probe" }>, paseo: PaseoApi) {
    const state = await this.serial(() => this.storage.load(paseo));
    const conn = findConnection(state, action.connection);
    const known = new Set(conn.models.map((model) => model.id));
    const models = action.models.filter((id) => known.has(id));
    if (!models.length) throw new Error(L("没有可测试的模型，请刷新连接后重试。", "No models to test. Refresh the connection and try again."));
    const results = await probeModels(conn, models);
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
        ? {
            message: L(
              `已测试 ${total} 个模型：${total - failed} 个可用，${failed} 个失败。`,
              `Tested ${count(total, "model", "models")}: ${total - failed} working, ${failed} failed.`,
            ),
            level: "warning",
          }
        : { message: L(`已测试 ${total} 个模型，全部可用。`, `Tested ${count(total, "model", "models")}, all working.`) };
    });
  }

  action(action: Action, paseo: PaseoApi) {
    if (action.type === "probe") return this.probe(action, paseo);
    return this.serial(async (): Promise<Omit<Operation, "job">> => {
      const current = await this.storage.load(paseo);
      this.committed = current;
      const next = structuredClone(current);
      let message = L("已保存", "Saved");
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
            message = L("目录没有模型，请检查网关的模型列表。", "The gateway listed no models. Check its model list.");
            level = "warning";
          } else if (issues.length === 0)
            message = L(
              `已检查 ${conn.models.length} 个模型，全部通过。`,
              `Checked ${count(conn.models.length, "model", "models")}, all passed.`,
            );
          else {
            testIssues = true;
            message =
              L(
                `已检查 ${conn.models.length} 个模型，发现 ${issues.length} 个问题：\n`,
                `Checked ${count(conn.models.length, "model", "models")}, found ${count(issues.length, "problem", "problems")}:\n`,
              ) +
              issues.slice(0, 8).join("\n") +
              (issues.length > 8 ? L(`\n…另有 ${issues.length - 8} 个问题`, `\n…and ${issues.length - 8} more`) : "");
            level = "warning";
          }
          break;
        }
        case "saveConnection": {
          const url = new URL(action.url);
          if (url.username || url.password || url.hash || url.search)
            throw new Error(
              L("网关地址不能包含凭据、查询参数或片段。", "The gateway URL cannot contain credentials, a query or a fragment."),
            );
          const name = action.name.trim();
          if (!name) throw new Error(L("请输入连接名称。", "Enter a connection name."));
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
            throw new Error(
              L("网关域名或端口变更，请为新地址重新输入 Key。", "The gateway host or port changed. Enter the key again for the new address."),
            );
          }
          // A copied connection may reuse the source key, but only for the same
          // origin: the key must never be sent to a host it was not saved for.
          let copiedKey: string | undefined;
          if (!action.id && action.copyKeyFrom && !action.key) {
            const source = findConnection(next, action.copyKeyFrom);
            if (new URL(source.url).origin !== url.origin)
              throw new Error(
                L("复制的连接更换了域名或端口，请重新输入 Key。", "The copy uses another host or port. Enter its key."),
              );
            copiedKey = source.key;
          }
          if (
            conn.protocol !== action.protocol &&
            next.bindings.some(
              (b) => b.connection === conn.id && b.selected.length,
            )
          )
            throw new Error(
              L("请先停用使用该连接的模型，再切换协议。", "Turn off the models that use this connection before switching the protocol."),
            );
          const protocolChanged = action.id !== undefined && conn.protocol !== action.protocol;
          const previousTarget = `${conn.url}|${conn.protocol}|${conn.key}`;
          Object.assign(conn, {
            name,
            url: action.url.replace(/\/+$/, ""),
            protocol: action.protocol,
            catalogProvider: action.catalogProvider,
            // A copy with a blank key field uses the source key.
            key: action.key ? action.key : copiedKey ?? action.key ?? conn.key,
          });
          conn.hasKey = !!conn.key;
          // Test results describe the old address, protocol or key.
          if (`${conn.url}|${conn.protocol}|${conn.key}` !== previousTarget) delete conn.probes;
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
            message = L("连接已保存，目录加载失败：", "Connection saved, but loading its models failed: ") + conn.error;
            level = "warning";
          } else message = L("连接已保存，模型目录已更新。", "Connection saved and its models updated.");
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
            L(
              `已拉取 ${conn.models.filter((m) => m.listed).length} 个模型。`,
              `Fetched ${count(conn.models.filter((m) => m.listed).length, "model", "models")}.`,
            );
          break;
        }
        case "refreshStale": {
          const stale = next.connections.filter(
            (c) => !c.lastRefresh || Date.now() - c.lastRefresh >= DAY,
          );
          if (!stale.length) return { message: L("目录已是最新", "Model lists are up to date") };
          await Promise.all(stale.map((c) => refresh(c)));
          const failed = stale.filter((c) => c.error).length;
          message = L(`已检查 ${stale.length} 个连接，失败 ${failed} 个。`, `Checked ${count(stale.length, "connection", "connections")}, ${failed} failed.`);
          if (failed) level = "warning";
          break;
        }
        case "selection": {
          const conn = findConnection(next, action.connection);
          if (action.fallback) setFallback(conn, action.fallback.context, action.fallback.output);
          applyChanges(conn, action.changes ?? []);
          const selected = [...new Set(action.selected)];
          const targets = [action.agent, ...(action.alsoApply ?? []).filter((a) => a !== action.agent)];
          let primaryDefault: string | undefined;
          for (const [index, agentId] of targets.entries()) {
            const descriptor = agents.find((a) => a.id === agentId);
            if (!descriptor?.protocols.includes(conn.protocol))
              throw new Error(
                L(
                  `${descriptor?.label ?? agentId} 不支持此连接的协议。`,
                  `${descriptor?.label ?? agentId} does not support this connection's protocol.`,
                ),
              );
            const binding = getBinding(next, agentId, conn.id);
            binding.selected = [...selected];
            if (index > 0) {
              // "同时应用到" copies the selection and the default model as they are
              // on the agent being edited, whether or not the default changed now.
              if (primaryDefault) binding.default = primaryDefault;
              else delete binding.default;
              continue;
            }
            if (action.default !== undefined) {
              if (action.default === null || !selected.includes(action.default)) delete binding.default;
              else binding.default = action.default;
            } else if (binding.default && !selected.includes(binding.default)) delete binding.default;
            primaryDefault = binding.default;
          }
          if (targets.length > 1)
            message = L(`已更新 ${targets.length} 个 Agent 的模型配置`, `Updated the models of ${count(targets.length, "agent", "agents")}`);
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
          message = changes.length
            ? L(`已采用 ${changes.length} 个推荐值。`, `Adopted ${count(changes.length, "suggested value", "suggested values")}.`)
            : L("没有待确认的推荐值。", "No suggested values to confirm.");
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
            message:
              message +
              L(
                "\n（因存在以上问题，本次获取的目录未保存，现有配置保持不变。）",
                "\n(Because of these problems the fetched model list was not saved; the current configuration is unchanged.)",
              ),
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
