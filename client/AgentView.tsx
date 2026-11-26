import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import type { Binding, Connection, Protocol, Snapshot } from "../shared/contracts";
import { AgentHeading } from "./AgentRail";
import {
  agentSummary,
  availableConnections,
  bindingsForAgent,
  connectionById,
  type AgentDescriptor,
} from "./derive";
import { protocolLabel } from "./format";
import { NativeModels } from "./NativeModels";
import { BoundConnectionCard, CompatiblePicker } from "./ConnectionCard";
import {
  Badge,
  Btn,
  Card,
  EmptyState,
  IconBtn,
  Notice,
  SectionHead,
  Sheet,
  Stat,
  useLayout,
  useTokens,
  withAlpha,
} from "./ui";

export function AgentView({
  snapshot,
  descriptor,
  busy,
  onManageModels,
  onEditConnection,
  onCreateConnection,
  onAdaptConnection,
  onDeleteConnection,
  onRefreshConnection,
  onTestConnection,
  onOpenLibrary,
}: {
  snapshot: Snapshot;
  descriptor: AgentDescriptor;
  busy: string | null;
  onManageModels: (connection: Connection) => void;
  onEditConnection: (connection: Connection) => void;
  onCreateConnection: () => void;
  /** Switch an unused OpenAI connection to the other OpenAI protocol, or copy it. */
  onAdaptConnection: (connection: Connection, mode: "switch" | "copy", protocol: Protocol) => void;
  onDeleteConnection: (connection: Connection) => void;
  onRefreshConnection: (connection: Connection) => void;
  onTestConnection: (connection: Connection) => void;
  onOpenLibrary: () => void;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  const [addOpen, setAddOpen] = useState(false);
  const summary = agentSummary(snapshot, descriptor.id);
  const bindings = bindingsForAgent(snapshot, descriptor.id);
  const available = availableConnections(snapshot, descriptor.id);

  const native = descriptor.protocols.length === 0;
  const openAdd = () => setAddOpen(true);
  const pickConnection = (connection: Connection) => {
    setAddOpen(false);
    onManageModels(connection);
  };

  if (native) {
    return (
      <View testID="ppm-agent-view" style={{ gap: compact ? 14 : 18 }}>
        <Card style={{ gap: 10 }}>
          <AgentHeading descriptor={descriptor} snapshot={snapshot} compact={compact} />
          <Text style={t.small}>
            模型由本机账号或云项目提供，不使用自建网关连接。可直接测试账号模型目录；不会发送推理消息。
          </Text>
        </Card>
        <Card style={{ gap: 10 }}>
          <NativeModels agent={descriptor.id} theme={theme} />
        </Card>
      </View>
    );
  }

  return (
    <View testID="ppm-agent-view" style={{ gap: compact ? 14 : 18 }}>
      <Card style={{ gap: 14 }}>
        <AgentHeading descriptor={descriptor} snapshot={snapshot} compact={compact} />

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            paddingTop: 11,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
          }}
        >
          <Stat label="连接" value={String(summary.bound)} />
          <Stat label="模型" value={String(summary.selected)} tone="accent" />
          {summary.conflicts ? (
            <Stat label="冲突" value={String(summary.conflicts)} tone="warning" />
          ) : null}
          {summary.missing ? (
            <Stat label="缺失" value={String(summary.missing)} tone="danger" />
          ) : null}
          {summary.errors ? (
            <Stat label="异常" value={String(summary.errors)} tone="danger" />
          ) : null}
          {summary.pending ? (
            <Stat label="待确认" value={String(summary.pending)} tone="warning" />
          ) : null}
        </View>
      </Card>

      <View style={{ gap: 10 }}>
        <SectionHead
          icon="Cable"
          title="供应商连接"
          trailing={
            <Btn
              label="添加连接"
              size="sm"
              icon="Plus"
              onPress={openAdd}
              disabled={Boolean(busy)}
              testID="ppm-add-connection"
            />
          }
        />
        {bindings.length ? (
          bindings.map((binding) => {
            const connection = connectionById(snapshot, binding.connection);
            if (!connection) {
              return (
                <MissingBindingCard key={binding.connection} binding={binding} />
              );
            }
            return (
              <BoundConnectionCard
                key={binding.connection}
                snapshot={snapshot}
                connection={connection}
                binding={binding}
                busy={busy}
                onManage={() => onManageModels(connection)}
                onEdit={() => onEditConnection(connection)}
                onRefresh={() => onRefreshConnection(connection)}
                onTest={() => onTestConnection(connection)}
                onDelete={() => onDeleteConnection(connection)}
              />
            );
          })
        ) : (
          <Card style={{ padding: 0 }}>
            <EmptyState
              icon="Cable"
              title="尚未配置供应商"
              description={`从连接库选择现有连接，或新建一个。${descriptor.label} 支持 ${descriptor.protocols
                .map(protocolLabel)
                .join(" / ")}。`}
            />
          </Card>
        )}
      </View>

      {available.length ? (
        <View style={{ gap: 8 }}>
          <SectionHead
            icon="Link2"
            title="可用连接"
            trailing={
              <Btn
                label="连接库"
                size="sm"
                variant="ghost"
                icon="ArrowUpRight"
                onPress={onOpenLibrary}
              />
            }
          />
          <View style={{ gap: 6 }}>
            {available.map((connection) => {
              return (
                <View
                  key={connection.id}
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
                  <Icon name="Server" size={15} color={theme.colors.foregroundMuted} />
                  <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                    <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <Text style={t.bodyStrong} numberOfLines={1}>
                        {connection.name}
                      </Text>
                      <Badge label={protocolLabel(connection.protocol)} />
                      {!connection.hasKey ? <Badge tone="warning" label="无密钥" /> : null}
                      {connection.error ? <Badge tone="danger" label="刷新失败" /> : null}
                    </View>
                    <Text style={t.tiny} numberOfLines={1}>
                      {connection.models.length} 个模型
                      {connection.catalogProvider ? ` · 目录 ${connection.catalogProvider}` : ""}
                    </Text>
                  </View>
                  <Btn
                    label="选择模型"
                    size="sm"
                    variant="secondary"
                    onPress={() => onManageModels(connection)}
                    disabled={Boolean(busy)}
                    testID={`ppm-add-existing-${connection.id}`}
                  />
                </View>
              );
            })}
          </View>
        </View>
      ) : null}


      <Sheet
        open={addOpen}
        onOpenChange={setAddOpen}
        title={`为 ${descriptor.label} 添加连接`}
        icon={<Icon name="Cable" size={18} color={theme.colors.accent} />}
        footer={<Btn label="取消" onPress={() => setAddOpen(false)} />}
      >
        <View
          style={{
            flexDirection: "row",
            gap: 8,
            alignItems: "flex-start",
            borderRadius: 9,
            backgroundColor: withAlpha(theme.colors.accent, 0.07),
            borderWidth: 1,
            borderColor: withAlpha(theme.colors.accent, 0.2),
            padding: 10,
          }}
        >
          <Icon name="Info" size={14} color={theme.colors.accent} />
          <Text style={[t.tiny, { flex: 1 }]}>
            协议兼容且尚未添加的连接可以直接选择；协议不兼容的连接会灰显并说明原因。选择连接后即可挑选模型与手动限额；密钥和目录仍然全局复用。
          </Text>
        </View>
        <CompatiblePicker
          snapshot={snapshot}
          agent={descriptor}
          busy={Boolean(busy)}
          onPick={pickConnection}
          onCreate={() => {
            setAddOpen(false);
            onCreateConnection();
          }}
          onAdapt={(connection, mode, protocol) => {
            setAddOpen(false);
            onAdaptConnection(connection, mode, protocol);
          }}
        />
      </Sheet>
    </View>
  );
}

function MissingBindingCard({ binding }: { binding: Binding }) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  return (
    <Card style={{ borderColor: withAlpha(theme.colors.statusWarning, 0.4) }}>
      <Notice tone="warning" title="绑定的连接已不存在">
        连接 {binding.connection} 已被删除或不再可用。刷新页面后绑定会同步；如果仍然存在，请删除并重新创建对应连接。
      </Notice>
    </Card>
  );
}
