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
        placeholder="搜索名称、地址、目录供应商或模型"
        testID="ppm-connection-search"
      />

      {snapshot.connections.length === 0 ? (
        <Card style={{ padding: 0 }}>
          <EmptyState
            icon="Server"
            title="连接库为空"
            description="添加一个 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 或 Google Gemini 网关连接，然后为 Agent 选择模型。"
            action={
              <Btn label="新建第一个连接" variant="primary" icon="Plus" onPress={onNew} />
            }
          />
        </Card>
      ) : connections.length === 0 ? (
        <Card style={{ padding: 0 }}>
          <EmptyState
            icon="Search"
            title="没有匹配的连接"
            description="换一个关键词，或者清空搜索查看全部连接。"
            action={<Btn label="清空搜索" onPress={() => setQuery("")} />}
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
              <Badge tone="danger" label="刷新失败" icon="AlertTriangle" />
            ) : stale ? (
              <Badge tone="warning" label="数据过期" />
            ) : (
              <Badge tone="success" label="已同步" />
            )}
            {connection.hasKey ? (
              <Badge tone="success" label="有密钥" />
            ) : (
              <Badge tone="warning" label="无密钥" />
            )}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={[t.mono, { flexShrink: 1 }]} numberOfLines={1}>
              {connection.url}
            </Text>
            <CopyButton text={connection.url} label="复制地址" />
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 1 }}>
          <IconBtn icon="Pencil" label={`编辑 ${connection.name}`} onPress={onEdit} />
          <IconBtn icon="Trash2" label={`删除 ${connection.name}`} tone="danger" onPress={onDelete} />
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Badge label={`已选 ${selectedTotal} / ${connection.models.length}`} icon="ListChecks" />
        {connection.catalogProvider ? (
          <Badge label={`目录 ${connection.catalogProvider}`} icon="Database" />
        ) : null}
        <Badge label={refreshLabel(connection.lastRefresh, now)} icon="Clock" />
      </View>

      {connection.error ? (
        <Notice tone="danger" title="最近一次刷新失败">
          {connection.error}
        </Notice>
      ) : stale ? (
        <Notice tone="warning" title="目录可能已过期">
          {connection.lastRefresh
            ? `上次刷新：${formatRelativeTime(connection.lastRefresh, now)}。`
            : "尚未成功刷新过。"}
          建议刷新后再为 Agent 选择模型。
        </Notice>
      ) : null}

      <View style={{ gap: 6 }}>
        <Text style={t.small}>使用此连接的 Agent</Text>
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
          <Text style={t.tiny}>尚未被任何 Agent 使用。在可用的 Agent 页面点击“添加连接”即可复用。</Text>
        )}
        <Text style={t.tiny}>
          可用于：{usable.map((agent) => agent.label).join(" · ") || "无"}
        </Text>
        {blocked.length ? (
          <Text style={t.tiny}>
            不适用：
            {blocked
              .map((agent) => `${agent.label}（需 ${agent.protocols.map(protocolLabel).join(" / ")}）`)
              .join("，")}
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
          label={refreshing ? "刷新中…" : "刷新目录"}
          icon="RefreshCw"
          onPress={onRefresh}
          pending={refreshing}
          disabled={Boolean(busy) && !refreshing}
          testID={`ppm-library-refresh-${connection.id}`}
        />
        <Btn
          label={testing ? "测试中…" : "测试全部模型"}
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
