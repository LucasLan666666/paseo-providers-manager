import type { AgentId, Snapshot } from "../shared/contracts";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, ScrollView, Text, View } from "react-native";
import { agentSummary, type AgentDescriptor } from "./derive";
import { protocolLabel } from "./format";
import { useLayout, useTokens, withAlpha } from "./ui";

const AGENT_ICON: Record<AgentId, string> = {
  claude: "Bot",
  codex: "Terminal",
  copilot: "Github",
  opencode: "Code2",
  pi: "Circle",
  omp: "Cpu",
  antigravity: "Rocket",
  muse: "Sparkles",
  fx: "FlaskConical",
  hoplite: "Shield",
};

export function AgentAvatar({
  agent,
  size = 30,
  selected = false,
}: {
  agent: AgentId;
  size?: number;
  selected?: boolean;
}) {
  const { theme } = useLayout();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: selected
          ? theme.colors.accent
          : withAlpha(theme.colors.foregroundMuted, 0.1),
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
      }}
    >
      <Icon
        name={AGENT_ICON[agent] ?? "Bot"}
        size={Math.round(size * 0.52)}
        color={selected ? theme.colors.accentForeground : theme.colors.foregroundMuted}
      />
    </View>
  );
}

export function AgentRail({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: Snapshot;
  selected: AgentId;
  onSelect: (agent: AgentId) => void;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  const now = Date.now();

  return (
    <View
      style={{
        width: compact ? undefined : 232,
        borderRightWidth: compact ? 0 : 1,
        borderRightColor: theme.colors.border,
        borderBottomWidth: compact ? 1 : 0,
        borderBottomColor: theme.colors.border,
        paddingTop: compact ? 0 : 16,
        paddingBottom: compact ? 0 : 12,
      }}
    >
      <ScrollView
        horizontal={compact}
        style={{ flex: compact ? undefined : 1 }}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: compact ? 16 : 10,
          paddingVertical: compact ? 10 : 2,
          gap: compact ? 8 : 3,
          flexDirection: compact ? "row" : "column",
        }}
      >
        {snapshot.agents.map((descriptor) => {
          const active = descriptor.id === selected;
          const summary = agentSummary(snapshot, descriptor.id, now);
          return (
            <Pressable
              key={descriptor.id}
              accessibilityRole="button"
              accessibilityLabel={`${descriptor.label}，${summary.bound} 个连接，${summary.selected} 个模型${
                summary.issues ? `，${summary.issues} 个待处理` : ""
              }`}
              accessibilityState={{ selected: active }}
              testID={`ppm-agent-${descriptor.id}`}
              onPress={() => onSelect(descriptor.id)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 9,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: active ? withAlpha(theme.colors.accent, 0.28) : "transparent",
                backgroundColor: active
                  ? withAlpha(theme.colors.accent, 0.11)
                  : pressed
                    ? withAlpha(theme.colors.foreground, 0.05)
                    : "transparent",
                paddingHorizontal: compact ? 9 : 8,
                paddingVertical: compact ? 7 : 8,
                minWidth: compact ? 0 : undefined,
              })}
            >
              <AgentAvatar agent={descriptor.id} selected={active} size={compact ? 26 : 30} />
              <View style={{ flex: compact ? 0 : 1, minWidth: 0, gap: 1 }}>
                <Text
                  numberOfLines={1}
                  style={{
                    color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
                    fontSize: compact ? 12 : 13,
                    fontWeight: active ? "600" : "500",
                  }}
                >
                  {descriptor.label}
                </Text>
                {!compact ? (
                  <Text numberOfLines={1} style={t.tiny}>
                    {descriptor.protocols.length === 0
                      ? "原生模型目录"
                      : summary.bound
                        ? `${summary.bound} 个连接 · ${summary.selected} 个模型`
                        : "尚未配置"}
                  </Text>
                ) : null}
              </View>
              {summary.issues ? (
                <View
                  style={{
                    minWidth: 17,
                    height: 17,
                    borderRadius: 9,
                    paddingHorizontal: 4,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: withAlpha(theme.colors.statusWarning, 0.16),
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.statusWarning,
                      fontSize: 10,
                      fontWeight: "700",
                      lineHeight: 13,
                    }}
                  >
                    {summary.issues}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function AgentHeading({
  descriptor,
  snapshot,
  compact,
}: {
  descriptor: AgentDescriptor;
  snapshot: Snapshot;
  compact: boolean;
}) {
  const { theme } = useLayout();
  const t = useTokens(theme, compact);
  const summary = agentSummary(snapshot, descriptor.id);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <AgentAvatar agent={descriptor.id} size={compact ? 42 : 48} selected />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text style={t.title} numberOfLines={1}>
          {descriptor.label}
        </Text>
        <Text style={t.muted} numberOfLines={2}>
          {descriptor.detail}
        </Text>
        <View style={t.wrap}>
          {descriptor.protocols.map((protocol) => (
            <View
              key={protocol}
              style={{
                borderRadius: 5,
                backgroundColor: theme.colors.surface2,
                paddingHorizontal: 6,
                paddingVertical: 1,
              }}
            >
              <Text style={[t.tiny, { color: theme.colors.foregroundMuted }]}>{protocolLabel(protocol)}</Text>
            </View>
          ))}
          <Text style={t.tiny}>
            {descriptor.protocols.length === 0
              ? "原生模型目录"
              : `${summary.bound} 个连接 · ${summary.selected} 个模型`}
          </Text>
        </View>
      </View>
    </View>
  );
}

