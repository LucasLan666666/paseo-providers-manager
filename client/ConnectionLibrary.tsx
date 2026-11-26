import { Icon } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { AgentId, Connection, Snapshot } from "../shared/contracts";
import { agentDescriptor, agentsUsing, isStaleConnection } from "./derive";
import {
  formatRelativeTime,
  protocolFullLabel,
  protocolLabel,
  refreshLabel,
} from "./format";
import {
  Badge,
  Btn,
  Card,
  CopyButton,
  EmptyState,
  IconBtn,
  Notice,
  SearchField,
  useLayout,
  useTokens,
  useTr,
  withAlpha,
} from "./ui";

export function ConnectionLibrary({
  snapshot,
  busy,
  onNew,
  onEdit,
  onDelete,
  onRefresh,
  onTest,
  onOpenAgent,
}: {
  snapshot: Snapshot;
  busy: string | null;
  onNew: () => void;
  onEdit: (connection: Connection) => void;
  onDelete: (connection: Connection) => void;
  onRefresh: (connection: Connection) => void;
  onTest: (connection: Connection) => void;
  onOpenAgent: (agent: AgentId) => void;
}) {
  const { theme, compact } = useLayout();
  const { tr } = useTr();
  const t = useTokens(theme, compact);
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();

  const connections = useMemo(() => {
    if (!normalized) return snapshot.connections;
    return snapshot.connections.filter((connection) => {
      if (
        connection.name.toLowerCase().includes(normalized) ||
        connection.url.toLowerCase().includes(normalized) ||
        connection.catalogProvider.toLowerCase().includes(normalized) ||
        connection.protocol.toLowerCase().includes(normalized) ||
        protocolFullLabel(connection.protocol).toLowerCase().includes(normalized)
      ) {
        return true;
      }
      return connection.models.some(
        (model) =>
          model.id.toLowerCase().includes(normalized) ||
          model.label.toLowerCase().includes(normalized),
      );
    });
  }, [snapshot.connections, normalized]);

  return (
    <View style={{ gap: 14 }}>
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder={tr("搜索名称、地址、目录供应商或模型", "Search names, URLs, catalog providers or models")}
        testID="ppm-connection-search"
      />

      {snapshot.connections.length === 0 ? (
        <Card style={{ padding: 0 }}>
          <EmptyState
            icon="Server"
            title={tr("连接库为空", "No connections yet")}
            description={tr(
              "添加一个 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 或 Google Gemini 网关连接，然后为 Agent 选择模型。",
              "Add an OpenAI Chat Completions, OpenAI Responses, Anthropic Messages or Google Gemini gateway, then choose models for an agent.",
            )}
            action={
              <Btn label={tr("新建第一个连接", "Create the first connection")} variant="primary" icon="Plus" onPress={onNew} />
            }
          />
        </Card>
      ) : connections.length === 0 ? (
        <Card style={{ padding: 0 }}>
          <EmptyState
            icon="Search"
            title={tr("没有匹配的连接", "No matching connections")}
            description={tr("换一个关键词，或者清空搜索查看全部连接。", "Try another keyword, or clear the search to see all connections.")}
            action={<Btn label={tr("清空搜索", "Clear search")} onPress={() => setQuery("")} />}
          />
        </Card>
      ) : (
        connections.map((connection) => (
          <LibraryCard
            key={connection.id}
            snapshot={snapshot}
            connection={connection}
            busy={busy}
            onEdit={() => onEdit(connection)}
            onDelete={() => onDelete(connection)}
            onRefresh={() => onRefresh(connection)}
            onTest={() => onTest(connection)}
            onOpenAgent={onOpenAgent}
          />
        ))
      )}
    </View>
  );
}

function LibraryCard({
  snapshot,
  connection,
  busy,
  onEdit,
  onDelete,
  onRefresh,
  onTest,
  onOpenAgent,
}: {
  snapshot: Snapshot;
  connection: Connection;
  busy: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onRefresh: () => void;
  onTest: () => void;
  onOpenAgent: (agent: AgentId) => void;
}) {
  const { theme, compact } = useLayout();
  const { tr, lang } = useTr();
  const t = useTokens(theme, compact);
  const now = Date.now();
  const agents = agentsUsing(snapshot, connection.id);
  const gatewayAgents = snapshot.agents.filter((agent) => agent.protocols.length > 0);
  const usable = gatewayAgents.filter((agent) => agent.protocols.includes(connection.protocol));
  const blocked = gatewayAgents.filter((agent) => !agent.protocols.includes(connection.protocol));
  const refreshing = busy === `refresh:${connection.id}`;
  const testing = busy === `testConnection:${connection.id}`;
  const stale = isStaleConnection(connection, now);
  const modelIds = new Set(connection.models.map((model) => model.id));
  const selectedTotal = snapshot.bindings
    .filter((binding) => binding.connection === connection.id)
    .reduce(
      (count, binding) => count + binding.selected.filter((id) => modelIds.has(id)).length,
      0,
    );

  return (
    <Card testID={`ppm-library-${connection.id}`} style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: withAlpha(theme.colors.accent, 0.1),
            borderWidth: 1,
            borderColor: withAlpha(theme.colors.accent, 0.2),
          }}
        >
          <Icon name="Server" size={17} color={theme.colors.accent} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <Text style={t.h2} numberOfLines={1}>
              {connection.name}
            </Text>
            <Badge tone="accent" label={protocolLabel(connection.protocol)} />
            {connection.error ? (
              <Badge tone="danger" label={tr("刷新失败", "Refresh failed")} icon="AlertTriangle" />
            ) : stale ? (
              <Badge tone="warning" label={tr("数据过期", "Stale")} />
            ) : (
              <Badge tone="success" label={tr("已同步", "Synced")} />
            )}
            {connection.hasKey ? (
              <Badge tone="success" label={tr("有密钥", "Key saved")} />
            ) : (
              <Badge tone="warning" label={tr("无密钥", "No key")} />
            )}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={[t.mono, { flexShrink: 1 }]} numberOfLines={1}>
              {connection.url}
            </Text>
            <CopyButton text={connection.url} label={tr("复制地址", "Copy URL")} />
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 1 }}>
          <IconBtn icon="Pencil" label={tr(`编辑 ${connection.name}`, `Edit ${connection.name}`)} onPress={onEdit} />
          <IconBtn icon="Trash2" label={tr(`删除 ${connection.name}`, `Delete ${connection.name}`)} tone="danger" onPress={onDelete} />
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Badge label={tr(`已选 ${selectedTotal} / ${connection.models.length}`, `${selectedTotal} / ${connection.models.length} selected`)} icon="ListChecks" />
        {connection.catalogProvider ? (
          <Badge label={tr(`目录 ${connection.catalogProvider}`, `Catalog ${connection.catalogProvider}`)} icon="Database" />
        ) : null}
        <Badge label={refreshLabel(connection.lastRefresh, lang, now)} icon="Clock" />
      </View>

      {connection.error ? (
        <Notice tone="danger" title={tr("最近一次刷新失败", "The last refresh failed")}>
          {connection.error}
        </Notice>
      ) : stale ? (
        <Notice tone="warning" title={tr("目录可能已过期", "The model list may be stale")}>
          {connection.lastRefresh
            ? tr(
                `上次刷新：${formatRelativeTime(connection.lastRefresh, lang, now)}。`,
                `Last refreshed ${formatRelativeTime(connection.lastRefresh, lang, now)}. `,
              )
            : tr("尚未成功刷新过。", "Never refreshed successfully. ")}
          {tr("建议刷新后再为 Agent 选择模型。", "Refresh before choosing models for an agent.")}
        </Notice>
      ) : null}

      <View style={{ gap: 6 }}>
        <Text style={t.small}>{tr("使用此连接的 Agent", "Agents using this connection")}</Text>
        {agents.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {agents.map((agentId) => {
              const descriptor = agentDescriptor(snapshot, agentId);
              return (
                <Btn
                  key={agentId}
                  label={descriptor?.label ?? agentId}
                  size="sm"
                  variant="secondary"
                  icon="Bot"
                  onPress={() => onOpenAgent(agentId)}
                />
              );
            })}
          </View>
        ) : (
          <Text style={t.tiny}>
            {tr(
              "尚未被任何 Agent 使用。在可用的 Agent 页面点击“添加连接”即可复用。",
              "No agent uses it yet. Use “Add connection” on a compatible agent's page to reuse it.",
            )}
          </Text>
        )}
        <Text style={t.tiny}>
          {tr("可用于：", "Works with: ")}
          {usable.map((agent) => agent.label).join(" · ") || tr("无", "none")}
        </Text>
        {blocked.length ? (
          <Text style={t.tiny}>
            {tr("不适用：", "Not for: ")}
            {blocked
              .map((agent) =>
                tr(
                  `${agent.label}（需 ${agent.protocols.map(protocolLabel).join(" / ")}）`,
                  `${agent.label} (needs ${agent.protocols.map(protocolLabel).join(" / ")})`,
                ),
              )
              .join(tr("，", ", "))}
          </Text>
        ) : null}
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          paddingTop: 10,
        }}
      >
        <Btn
          label={refreshing ? tr("刷新中…", "Refreshing…") : tr("刷新目录", "Refresh models")}
          icon="RefreshCw"
          onPress={onRefresh}
          pending={refreshing}
          disabled={Boolean(busy) && !refreshing}
          testID={`ppm-library-refresh-${connection.id}`}
        />
        <Btn
          label={testing ? tr("测试中…", "Testing…") : tr("测试全部模型", "Test all models")}
          icon="Activity"
          onPress={onTest}
          pending={testing}
          disabled={Boolean(busy) && !testing}
          testID={`ppm-library-test-${connection.id}`}
        />
        <View style={{ flex: 1 }} />
      </View>
    </Card>
  );
}
