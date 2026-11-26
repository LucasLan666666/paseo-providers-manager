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
  count,
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
  useTr,
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
  const { tr, lang } = useTr();
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
          <IconBtn
            icon="Trash2"
            label={tr(`删除 ${connection.name}`, `Delete ${connection.name}`)}
            tone="danger"
            onPress={onDelete}
          />
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Badge
          label={tr(`已选 ${selected.length} / ${connection.models.length}`, `${selected.length} / ${connection.models.length} selected`)}
          tone={binding.selected.length ? "accent" : "warning"}
          icon="ListChecks"
        />
        {connection.catalogProvider ? (
          <Badge label={tr(`目录 ${connection.catalogProvider}`, `Catalog ${connection.catalogProvider}`)} icon="Database" />
        ) : null}
        <Badge label={refreshLabel(connection.lastRefresh, lang, now)} icon="Clock" />
      </View>

      {connection.error ? (
        <Notice
          tone="danger"
          title={tr("最近一次刷新失败", "The last refresh failed")}
          action={
            <Btn
              label={tr("重试", "Retry")}
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
          title={tr("模型目录可能已过期", "The model list may be stale")}
          action={
            <Btn
              label={tr("刷新", "Refresh")}
              size="sm"
              variant="ghost"
              onPress={onRefresh}
              pending={refreshing}
            />
          }
        >
          {connection.lastRefresh
            ? tr(
                `上次刷新：${formatRelativeTime(connection.lastRefresh, lang, now)}。`,
                `Last refreshed ${formatRelativeTime(connection.lastRefresh, lang, now)}. `,
              )
            : tr("尚未成功刷新过。", "Never refreshed successfully. ")}
          {tr("过期连接会在打开页面时自动刷新。", "Stale connections refresh when the page opens.")}
        </Notice>
      ) : null}

      {missingCount ? (
        <Notice
          tone="warning"
          title={tr(`${missingCount} 个已选模型缺失`, `Selected models missing: ${missingCount}`)}
          action={
            <Btn label={tr("处理", "Fix")} size="sm" variant="ghost" onPress={onManage} />
          }
        >
          {missing.length
            ? tr(
                `${missing.length} 个模型已不在保存的目录中，保存选择前需要移除。`,
                `No longer in the saved list (remove before saving): ${count(missing.length, "model", "models")}.`,
              )
            : ""}
          {unlisted.length
            ? (missing.length ? " " : "") +
              tr(
                `${unlisted.length} 个模型仍在本地目录中，但网关已不再列出它们；可继续使用已保存的参数或移除。`,
                `Saved locally but no longer listed by the gateway: ${count(unlisted.length, "model", "models")}; keep using the saved values or remove them.`,
              )
            : ""}
        </Notice>
      ) : null}

      {conflicts ? (
        <Notice
          tone="warning"
          title={tr(`${conflicts} 个手动限额与自动值冲突`, `${conflicts} manual limits differ from new automatic values`)}
          action={<Btn label={tr("查看", "Review")} size="sm" variant="ghost" onPress={onManage} />}
        >
          {tr(
            "网关或目录给出了新的容量值，请选择保留手动值或采用自动值。",
            "The gateway or catalog reports new limits; keep your manual values or use the automatic ones.",
          )}
        </Notice>
      ) : null}

      {pending.length ? (
        <Notice
          tone="warning"
          title={tr(`${pending.length} 个已选模型有待确认的推荐值`, `Suggested values to confirm: ${count(pending.length, "selected model", "selected models")}`)}
          action={<Btn label={tr("查看", "Review")} size="sm" variant="ghost" onPress={onManage} />}
        >
          {tr(
            "这些值是按同系列推测的，或网上没有公布输出上限。确认前先使用兜底值。",
            "These are guesses from related models, or the output limit is unpublished. Fallback values apply until you confirm.",
          )}
        </Notice>
      ) : null}

      {nonChat.length ? (
        <Notice
          tone="warning"
          title={tr(`已选 ${nonChat.length} 个非对话模型`, `Selected but cannot chat: ${count(nonChat.length, "model", "models")}`)}
          action={<Btn label={tr("处理", "Fix")} size="sm" variant="ghost" onPress={onManage} />}
        >
          {tr(
            `${nonChat.slice(0, 3).map((model) => model.id).join("、")}${nonChat.length > 3 ? " 等" : ""}不能用于对话，建议从选择中移除。`,
            `${nonChat.slice(0, 3).map((model) => model.id).join(", ")}${nonChat.length > 3 ? " and more" : ""} cannot be used for chat; remove them from the selection.`,
          )}
        </Notice>
      ) : null}

      {fresh.length ? (
        <Notice
          tone="accent"
          title={tr(`网关新增 ${fresh.length} 个模型`, `The gateway added ${count(fresh.length, "model", "models")}`)}
          action={<Btn label={tr("查看", "Review")} size="sm" variant="ghost" onPress={onManage} />}
        >
          {tr(
            `${fresh.slice(0, 3).map((model) => model.id).join("、")}${fresh.length > 3 ? " 等" : ""}。新模型不会自动启用。`,
            `${fresh.slice(0, 3).map((model) => model.id).join(", ")}${fresh.length > 3 ? " and more" : ""}. New models are not enabled automatically.`,
          )}
        </Notice>
      ) : null}

      <View style={{ gap: 7 }}>
        <Text style={t.small}>{tr("已选模型", "Selected models")}</Text>
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
              <Text style={t.bodyStrong}>{tr("尚未选择模型", "No models selected")}</Text>
              <Text style={t.tiny}>{tr("为该 Agent 选择此连接允许使用的模型与限额。", "Choose which models of this connection the agent may use, and their limits.")}</Text>
            </View>
            <Btn label={tr("选择模型", "Choose models")} size="sm" variant="primary" onPress={onManage} />
          </View>
        )}
        {missingCount ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name="TriangleAlert" size={13} color={theme.colors.statusWarning} />
            <Text style={[t.tiny, { color: theme.colors.statusWarning }]}>
              {tr(`${missingCount} 个模型缺失`, `Missing: ${count(missingCount, "model", "models")}`)}
              {missing.length ? `${tr("：", ": ")}${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}` : ""}
              {unlisted.length
                ? `${missing.length ? tr("；", "; ") : tr("：", ": ")}${unlisted.slice(0, 3).map((model) => model.label || model.id).join(", ")}${unlisted.length > 3 ? "…" : ""}`
                : ""}
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
          label={binding.selected.length ? tr("模型与限额", "Models & limits") : tr("选择模型", "Choose models")}
          icon="ListChecks"
          onPress={onManage}
          testID={`ppm-manage-models-${connection.id}`}
        />
        <Btn
          label={refreshing ? tr("刷新中…", "Refreshing…") : tr("刷新目录", "Refresh models")}
          icon="RefreshCw"
          onPress={onRefresh}
          pending={refreshing}
          disabled={Boolean(busy) && !refreshing}
          testID={`ppm-refresh-${connection.id}`}
        />
        <Btn
          label={testing ? tr("测试中…", "Testing…") : tr("测试全部模型", "Test all models")}
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
  const { tr, lang } = useTr();
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
          {connection.error ? <Badge tone="danger" label={tr("刷新失败", "Refresh failed")} /> : null}
          {!connection.hasKey ? <Badge tone="warning" label={tr("无密钥", "No key")} /> : null}
        </View>
        <Text style={t.tiny} numberOfLines={1}>
          {tr(`${connection.models.length} 个模型`, count(connection.models.length, "model", "models"))}
          {connection.catalogProvider ? tr(` · 目录 ${connection.catalogProvider}`, ` · catalog ${connection.catalogProvider}`) : ""}
          {` · ${formatRelativeTime(connection.lastRefresh, lang)}`}
        </Text>
      </View>
      <Btn
        label={tr("选择模型", "Choose models")}
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
  const { tr, lang } = useTr();
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
          <Text style={t.bodyStrong}>{tr("没有可直接添加的连接", "No connection can be added directly")}</Text>
          <Text style={[t.tiny, { textAlign: "center" }]}>
            {tr(
              `${agent.label} 需要 ${agent.protocols.map(protocolFullLabel).join(" / ")}。可以新建一个连接${incompatible.length ? "，或处理下方协议不兼容的连接" : ""}。`,
              `${agent.label} needs ${agent.protocols.map(protocolFullLabel).join(" / ")}. Create a connection${incompatible.length ? ", or adapt an incompatible one below" : ""}.`,
            )}
          </Text>
        </View>
      )}
      {incompatible.length ? (
        <View style={{ gap: 6 }}>
          <Text style={t.small}>{tr("协议不兼容", "Incompatible protocol")}</Text>
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
      <Btn label={tr("新建连接", "New connection")} icon="Plus" onPress={onCreate} disabled={busy} fullWidth />
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
  const { tr, lang } = useTr();
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
          {tr(
            `${agent.label} 需要 ${agent.protocols.map(protocolLabel).join(" / ")}${
              target
                ? inUse
                  ? `。此连接正被其他 Agent 使用；若网关也提供 ${protocolDescription(target, lang)}，可复制一份`
                  : `。若网关也提供 ${protocolDescription(target, lang)}，可直接改用`
                : "。"
            }`,
            `${agent.label} needs ${agent.protocols.map(protocolLabel).join(" / ")}${
              target
                ? inUse
                  ? `. Other agents use this connection; if the gateway also serves ${protocolDescription(target, lang)}, copy it`
                  : `. If the gateway also serves ${protocolDescription(target, lang)}, switch it`
                : "."
            }`,
          )}
        </Text>
      </View>
      {target ? (
        <Btn
          label={
            inUse
              ? tr(`复制为 ${protocolLabel(target)}`, `Copy as ${protocolLabel(target)}`)
              : tr(`改为 ${protocolLabel(target)}`, `Switch to ${protocolLabel(target)}`)
          }
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
