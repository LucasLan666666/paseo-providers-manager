import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { Binding, Connection, Model, Protocol, Snapshot } from "../shared/contracts";
import { counterpartProtocol } from "../shared/protocols";
import {
  conflictsFor,
  freshModels,
  isStaleConnection,
  missingModelIds,
  missingSelectionCount,
  nonChatSelected,
  pendingModels,
  resolveLimit,
  selectedModels,
  unlistedSelectedModels,
  type AgentDescriptor,
} from "./derive";
import {
  formatRelativeTime,
  formatTokens,
  protocolDescription,
  protocolFullLabel,
  protocolLabel,
  refreshLabel,
} from "./format";
import {
  Badge,
  Btn,
  Card,
  CopyButton,
  IconBtn,
  Notice,
  useLayout,
  useTokens,
  withAlpha,
} from "./ui";

export function BoundConnectionCard({
  snapshot,
  connection,
  binding,
  busy,
  onManage,
  onEdit,
  onRefresh,
  onTest,
  onDelete,
}: {
  snapshot: Snapshot;
  connection: Connection;
  binding: Binding;
  busy: string | null;
  onManage: () => void;
  onEdit: () => void;
  onRefresh: () => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  const now = Date.now();
  const missing = missingModelIds(binding, connection);
  const unlisted = unlistedSelectedModels(binding, connection);
  const missingCount = missingSelectionCount(binding, connection);
  const selected = selectedModels(binding, connection);
  const refreshing = busy === `refresh:${connection.id}`;
  const testing = busy === `testConnection:${connection.id}`;
  const stale = isStaleConnection(connection, now);
  const conflicts = selected.reduce(
    (count, model) => count + conflictsFor(connection, model).length,
    0,
  );
  const pending = pendingModels(connection, binding.selected);
  const fresh = freshModels(connection);
  const nonChat = nonChatSelected(binding, connection);

  return (
    <Card testID={`ppm-connection-card-${connection.id}`} style={{ gap: 11 }}>
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
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
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
          <IconBtn
            icon="Trash2"
            label={`删除 ${connection.name}`}
            tone="danger"
            onPress={onDelete}
          />
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Badge
          label={`已选 ${selected.length} / ${connection.models.length}`}
          tone={binding.selected.length ? "accent" : "warning"}
          icon="ListChecks"
        />
        {connection.catalogProvider ? (
          <Badge label={`目录 ${connection.catalogProvider}`} icon="Database" />
        ) : null}
        <Badge label={refreshLabel(connection.lastRefresh, now)} icon="Clock" />
      </View>

      {connection.error ? (
        <Notice
          tone="danger"
          title="最近一次刷新失败"
          action={
            <Btn
              label="重试"
              size="sm"
              variant="ghost"
              onPress={onRefresh}
              pending={refreshing}
            />
          }
        >
          {connection.error}
        </Notice>
      ) : stale ? (
        <Notice
          tone="warning"
          title="模型目录可能已过期"
          action={
            <Btn
              label="刷新"
              size="sm"
              variant="ghost"
              onPress={onRefresh}
              pending={refreshing}
            />
          }
        >
          {connection.lastRefresh
            ? `上次刷新：${formatRelativeTime(connection.lastRefresh, now)}。`
            : "尚未成功刷新过。"}
          过期连接会在打开页面时自动刷新。
        </Notice>
      ) : null}

      {missingCount ? (
        <Notice
          tone="warning"
          title={`${missingCount} 个已选模型缺失`}
          action={
            <Btn label="处理" size="sm" variant="ghost" onPress={onManage} />
          }
        >
          {missing.length
            ? `${missing.length} 个模型已不在保存的目录中，保存选择前需要移除。`
            : ""}
          {unlisted.length
            ? `${missing.length ? " " : ""}${unlisted.length} 个模型仍在本地目录中，但网关已不再列出它们；可继续使用已保存的参数或移除。`
            : ""}
        </Notice>
      ) : null}

      {conflicts ? (
        <Notice
          tone="warning"
          title={`${conflicts} 个手动限额与自动值冲突`}
          action={<Btn label="查看" size="sm" variant="ghost" onPress={onManage} />}
        >
          网关或目录给出了新的容量值，请选择保留手动值或采用自动值。
        </Notice>
      ) : null}

      {pending.length ? (
        <Notice
          tone="warning"
          title={`${pending.length} 个已选模型有待确认的推荐值`}
          action={<Btn label="查看" size="sm" variant="ghost" onPress={onManage} />}
        >
          这些值是按同系列推测的，或网上没有公布输出上限。确认前先使用兜底值。
        </Notice>
      ) : null}

      {nonChat.length ? (
        <Notice
          tone="warning"
          title={`已选 ${nonChat.length} 个非对话模型`}
          action={<Btn label="处理" size="sm" variant="ghost" onPress={onManage} />}
        >
          {nonChat.slice(0, 3).map((model) => model.id).join("、")}
          {nonChat.length > 3 ? " 等" : ""}不能用于对话，建议从选择中移除。
        </Notice>
      ) : null}

      {fresh.length ? (
        <Notice
          tone="accent"
          title={`网关新增 ${fresh.length} 个模型`}
          action={<Btn label="查看" size="sm" variant="ghost" onPress={onManage} />}
        >
          {fresh.slice(0, 3).map((model) => model.id).join("、")}
          {fresh.length > 3 ? " 等" : ""}。新模型不会自动启用。
        </Notice>
      ) : null}

      <View style={{ gap: 7 }}>
        <Text style={t.small}>已选模型</Text>
        {selected.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {selected.slice(0, compact ? 4 : 8).map((model) => (
              <SelectedModelChip
                key={model.id}
                model={model}
                connection={connection}
              />
            ))}
            {selected.length > (compact ? 4 : 8) ? (
              <Badge label={`+${selected.length - (compact ? 4 : 8)}`} />
            ) : null}
          </View>
        ) : (
          <View
            style={{
              borderRadius: 9,
              borderWidth: 1,
              borderStyle: "dashed",
              borderColor: theme.colors.border,
              padding: 10,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={t.bodyStrong}>尚未选择模型</Text>
              <Text style={t.tiny}>为该 Agent 选择此连接允许使用的模型与限额。</Text>
            </View>
            <Btn label="选择模型" size="sm" variant="primary" onPress={onManage} />
          </View>
        )}
        {missingCount ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name="TriangleAlert" size={13} color={theme.colors.statusWarning} />
            <Text style={[t.tiny, { color: theme.colors.statusWarning }]}>
              {missingCount} 个模型缺失
              {missing.length ? `：${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}` : ""}
              {unlisted.length ? `${missing.length ? "；" : "："}${unlisted.slice(0, 3).map((model) => model.label || model.id).join(", ")}${unlisted.length > 3 ? "…" : ""}` : ""}
            </Text>
          </View>
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
          label={binding.selected.length ? "模型与限额" : "选择模型"}
          icon="ListChecks"
          onPress={onManage}
          testID={`ppm-manage-models-${connection.id}`}
        />
        <Btn
          label={refreshing ? "刷新中…" : "刷新目录"}
          icon="RefreshCw"
          onPress={onRefresh}
          pending={refreshing}
          disabled={Boolean(busy) && !refreshing}
          testID={`ppm-refresh-${connection.id}`}
        />
        <Btn
          label={testing ? "测试中…" : "测试全部模型"}
          icon="Activity"
          onPress={onTest}
          pending={testing}
          disabled={Boolean(busy) && !testing}
          testID={`ppm-test-all-${connection.id}`}
        />
        <View style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

function SelectedModelChip({
  model,
  connection,
}: {
  model: Model;
  connection: Connection;
}) {
  const { theme } = useLayout();
  const context = resolveLimit(connection, model, "context");
  const output = resolveLimit(connection, model, "output");
  const conflict = conflictsFor(connection, model).length > 0;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderWidth: 1,
        borderColor: conflict
          ? withAlpha(theme.colors.statusWarning, 0.4)
          : theme.colors.border,
        backgroundColor: conflict
          ? withAlpha(theme.colors.statusWarning, 0.07)
          : theme.colors.surface2,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 3,
        maxWidth: "100%",
      }}
    >
      <Text
        style={{ color: theme.colors.foreground, fontSize: 11.5, fontWeight: "500" }}
        numberOfLines={1}
      >
        {model.label || model.id}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10.5 }}>
        {formatTokens(context.value)} / {formatTokens(output.value)}
      </Text>
      {conflict ? (
        <Icon name="AlertTriangle" size={11} color={theme.colors.statusWarning} />
      ) : null}
    </View>
  );
}

export function AvailableConnectionRow({
  connection,
  disabled,
  onAdd,
}: {
  connection: Connection;
  disabled: boolean;
  onAdd: () => void;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  return (
    <View
      testID={`ppm-available-${connection.id}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 9,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        padding: 10,
      }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.surface2,
        }}
      >
        <Icon name="Server" size={14} color={theme.colors.foregroundMuted} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Text style={t.bodyStrong} numberOfLines={1}>
            {connection.name}
          </Text>
          <Badge tone="accent" label={protocolLabel(connection.protocol)} />
          {connection.error ? <Badge tone="danger" label="刷新失败" /> : null}
          {!connection.hasKey ? <Badge tone="warning" label="无密钥" /> : null}
        </View>
        <Text style={t.tiny} numberOfLines={1}>
          {connection.models.length} 个模型
          {connection.catalogProvider ? ` · 目录 ${connection.catalogProvider}` : ""}
          {` · ${formatRelativeTime(connection.lastRefresh)}`}
        </Text>
      </View>
      <Btn
        label="选择模型"
        size="sm"
        variant="primary"
        icon="Plus"
        onPress={onAdd}
        disabled={disabled}
      />
    </View>
  );
}

export function CompatiblePicker({
  snapshot,
  agent,
  busy,
  onPick,
  onCreate,
  onAdapt,
  testID,
}: {
  snapshot: Snapshot;
  agent: AgentDescriptor;
  busy: boolean;
  onPick: (connection: Connection) => void;
  onCreate: () => void;
  onAdapt: (connection: Connection, mode: "switch" | "copy", protocol: Protocol) => void;
  testID?: string;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  const bound = new Set(
    snapshot.bindings.filter((entry) => entry.agent === agent.id).map((entry) => entry.connection),
  );
  const compatible = snapshot.connections.filter(
    (connection) => agent.protocols.includes(connection.protocol) && !bound.has(connection.id),
  );
  const incompatible = snapshot.connections.filter(
    (connection) => !agent.protocols.includes(connection.protocol) && !bound.has(connection.id),
  );
  return (
    <View testID={testID} style={{ gap: 9 }}>
      {compatible.length ? (
        compatible.map((connection) => (
          <AvailableConnectionRow
            key={connection.id}
            connection={connection}
            disabled={busy}
            onAdd={() => onPick(connection)}
          />
        ))
      ) : (
        <View
          style={{
            borderRadius: 10,
            borderWidth: 1,
            borderStyle: "dashed",
            borderColor: theme.colors.border,
            padding: 14,
            alignItems: "center",
            gap: 5,
          }}
        >
          <Text style={t.bodyStrong}>没有可直接添加的连接</Text>
          <Text style={[t.tiny, { textAlign: "center" }]}>
            {agent.label} 需要 {agent.protocols.map(protocolFullLabel).join(" / ")}。可以新建一个连接
            {incompatible.length ? "，或处理下方协议不兼容的连接" : ""}。
          </Text>
        </View>
      )}
      {incompatible.length ? (
        <View style={{ gap: 6 }}>
          <Text style={t.small}>协议不兼容</Text>
          {incompatible.map((connection) => (
            <IncompatibleConnectionRow
              key={connection.id}
              snapshot={snapshot}
              connection={connection}
              agent={agent}
              disabled={busy}
              onAdapt={onAdapt}
            />
          ))}
        </View>
      ) : null}
      <Btn label="新建连接" icon="Plus" onPress={onCreate} disabled={busy} fullWidth />
    </View>
  );
}

function IncompatibleConnectionRow({
  snapshot,
  connection,
  agent,
  disabled,
  onAdapt,
}: {
  snapshot: Snapshot;
  connection: Connection;
  agent: AgentDescriptor;
  disabled: boolean;
  onAdapt: (connection: Connection, mode: "switch" | "copy", protocol: Protocol) => void;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  // Only the OpenAI pair is offered as a fix: the same base URL usually serves
  // both. Anthropic or Gemini connections have different URLs and model lists.
  const counterpart = counterpartProtocol(connection.protocol);
  const target = counterpart && agent.protocols.includes(counterpart) ? counterpart : undefined;
  const inUse = snapshot.bindings.some(
    (binding) => binding.connection === connection.id && binding.selected.length > 0,
  );
  return (
    <View
      testID={`ppm-incompatible-${connection.id}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 9,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: theme.colors.border,
        padding: 10,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2, opacity: 0.75 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Text style={t.bodyStrong} numberOfLines={1}>
            {connection.name}
          </Text>
          <Badge label={protocolLabel(connection.protocol)} />
        </View>
        <Text style={t.tiny}>
          {agent.label} 需要 {agent.protocols.map(protocolLabel).join(" / ")}
          {target
            ? inUse
              ? `。此连接正被其他 Agent 使用；若网关也提供 ${protocolDescription(target)}，可复制一份`
              : `。若网关也提供 ${protocolDescription(target)}，可直接改用`
            : "。"}
        </Text>
      </View>
      {target ? (
        <Btn
          label={inUse ? `复制为 ${protocolLabel(target)}` : `改为 ${protocolLabel(target)}`}
          size="sm"
          variant="secondary"
          onPress={() => onAdapt(connection, inUse ? "copy" : "switch", target)}
          disabled={disabled}
          testID={`ppm-adapt-${connection.id}`}
        />
      ) : null}
    </View>
  );
}
