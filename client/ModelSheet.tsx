import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type {
  Action,
  AgentId,
  Binding,
  CapabilityField,
  Connection,
  Limits,
  Model,
  ModelKind,
  ModelSetting,
  Override,
  SettingChange,
  Snapshot,
} from "../shared/contracts";
import {
  defaultModelId,
  fallbackLimits,
  isChatModel,
  resolveModel,
  type LimitField,
  type LimitSource,
  type ResolvedModel,
} from "../shared/limits";
import { conflictsFor, modelById, type AgentDescriptor } from "./derive";
import {
  formatTokens,
  formatTokensFull,
  parseTokens,
  protocolLabel,
  rawTokens,
  sameStringSet,
} from "./format";
import type { RunOptions } from "./useManager";
import {
  Badge,
  Btn,
  Chip,
  ConfirmDialog,
  IconBtn,
  Notice,
  SearchField,
  Segmented,
  Sheet,
  TextField,
  useLayout,
  useTokens,
  withAlpha,
} from "./ui";

type FilterTab = "all" | "selected" | "issues";
type CapsDraft = Record<string, Partial<Record<CapabilityField, boolean>>>;

const CAPABILITIES: Array<{ field: CapabilityField; label: string; icon: string }> = [
  { field: "reasoning", label: "推理", icon: "Brain" },
  { field: "image", label: "图片输入", icon: "Image" },
  { field: "tools", label: "工具调用", icon: "Wrench" },
];

const KIND_LABELS: Record<ModelKind, string> = {
  chat: "对话",
  embedding: "嵌入模型",
  reranking: "重排模型",
  image: "图像模型",
  audio: "语音模型",
  video: "视频模型",
  other: "非对话模型",
};

const SUGGESTION_REASONS = {
  guess: "按同系列模型推测",
  "output-unknown": "网上没有公布输出上限",
  loose: "只在第三方目录中找到",
} as const;

function fieldKey(model: string, field: LimitField): string {
  return `${model}::${field}`;
}

function sourceText(source: LimitSource, ref?: string): string {
  if (source === "manual") return "手动";
  if (source === "gateway") return "网关";
  if (source === "catalog") return ref ? "网上匹配" : "目录";
  return "兜底";
}

/** Draft manual values as connection settings, so the shared resolver can preview them. */
function draftSettings(
  connection: Connection,
  texts: Record<string, string>,
  caps: CapsDraft,
): Record<string, ModelSetting> {
  const settings: Record<string, ModelSetting> = {};
  for (const model of connection.models) {
    const saved = connection.settings?.[model.id] ?? {};
    const row: ModelSetting = {};
    for (const field of ["context", "output"] as const) {
      const key = fieldKey(model.id, field);
      if (!(key in texts)) {
        if (saved[field]) row[field] = saved[field];
        continue;
      }
      const parsed = parseTokens(texts[key]);
      if (parsed.value !== undefined) row[field] = { value: parsed.value };
    }
    const draft = caps[model.id];
    for (const { field } of CAPABILITIES) {
      const value = draft && field in draft ? draft[field] : saved[field];
      if (value !== undefined) row[field] = value;
    }
    if (Object.keys(row).length) settings[model.id] = row;
  }
  return settings;
}

function collectChanges(
  connection: Connection,
  texts: Record<string, string>,
  caps: CapsDraft,
  acknowledged: ReadonlySet<string>,
): { changes: SettingChange[]; errors: Record<string, string> } {
  const changes: SettingChange[] = [];
  const errors: Record<string, string> = {};
  for (const [key, raw] of Object.entries(texts)) {
    const [model, field] = key.split("::") as [string, LimitField];
    if (!modelById(connection, model)) continue;
    const initial = connection.settings?.[model]?.[field];
    const text = raw.trim();
    if (!text) {
      if (initial) changes.push({ model, field, value: null });
      continue;
    }
    const parsed = parseTokens(text);
    if (parsed.error) {
      errors[key] = parsed.error;
      continue;
    }
    if (parsed.value !== undefined && (initial?.value !== parsed.value || acknowledged.has(key)))
      changes.push({ model, field, value: parsed.value });
  }
  for (const [model, draft] of Object.entries(caps)) {
    for (const { field } of CAPABILITIES) {
      if (!(field in draft)) continue;
      const value = draft[field];
      if (value === connection.settings?.[model]?.[field]) continue;
      changes.push({ model, field, value: value ?? null });
    }
  }
  return { changes, errors };
}

export function ModelSheet({
  open,
  agent,
  connection,
  binding,
  snapshot,
  busy,
  onClose,
  onEditConnection,
  run,
  reload,
}: {
  open: boolean;
  agent: AgentDescriptor;
  connection: Connection | null;
  binding: Binding | undefined;
  snapshot: Snapshot;
  busy: string | null;
  onClose: () => void;
  onEditConnection: (connection: Connection) => void;
  run: (action: Action, options?: RunOptions) => Promise<boolean>;
  reload: () => Promise<boolean>;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  const toast = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const [explicitDefault, setExplicitDefault] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [caps, setCaps] = useState<CapsDraft>({});
  const [fallbackText, setFallbackText] = useState({ context: "", output: "" });
  const [alsoApply, setAlsoApply] = useState<AgentId[]>([]);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<FilterTab>("all");
  const [visibleLimit, setVisibleLimit] = useState(80);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmEdit, setConfirmEdit] = useState(false);
  // Clear the 「新」 marks once the sheet has been seen (on close, not on open,
  // so the marks stay visible while looking at them).
  const sawFresh = useRef(false);

  useEffect(() => {
    if (!open || !connection) return;
    const initialSelected = binding?.selected ?? [];
    setSelected([...initialSelected]);
    setExplicitDefault(binding?.default ?? null);
    const nextTexts: Record<string, string> = {};
    for (const [id, entry] of Object.entries(connection.settings ?? {})) {
      for (const field of ["context", "output"] as const)
        if (entry[field]) nextTexts[fieldKey(id, field)] = rawTokens(entry[field]?.value);
    }
    setTexts(nextTexts);
    setCaps({});
    setFallbackText({
      context: rawTokens(connection.fallback?.context),
      output: rawTokens(connection.fallback?.output),
    });
    setAlsoApply([]);
    const nextExpanded = new Set<string>();
    for (const id of initialSelected) {
      const model = modelById(connection, id);
      if (model && conflictsFor(connection, model).length > 0) nextExpanded.add(id);
    }
    setAcknowledged(new Set());
    setExpanded(nextExpanded);
    setQuery("");
    setTab("all");
    setVisibleLimit(80);
    setSaving(false);
    setConfirmDiscard(false);
    setConfirmRemove(false);
    setConfirmEdit(false);
    sawFresh.current = connection.models.some((model) => model.fresh);
  }, [open, connection?.id]);

  const closeSheet = () => {
    if (sawFresh.current && connection) {
      sawFresh.current = false;
      void run({ type: "markSeen", connection: connection.id }, { key: "markSeen", toast: false });
    }
    onClose();
  };

  const draft = useMemo(() => {
    if (!connection) return null;
    const fallback: Limits = {};
    const errors: Record<string, string> = {};
    for (const field of ["context", "output"] as const) {
      const parsed = parseTokens(fallbackText[field]);
      if (parsed.error) errors[field] = parsed.error;
      else if (parsed.value !== undefined) fallback[field] = parsed.value;
    }
    if (!errors.context && !errors.output && fallback.context && fallback.output && fallback.output >= fallback.context)
      errors.output = "兜底输出必须小于兜底上下文";
    return {
      view: { ...connection, fallback, settings: draftSettings(connection, texts, caps) } as Connection,
      fallback,
      fallbackErrors: errors,
    };
  }, [connection, texts, caps, fallbackText]);

  const collected = useMemo(() => {
    if (!connection) return { changes: [], errors: {} };
    return collectChanges(connection, texts, caps, acknowledged);
  }, [connection, texts, caps, acknowledged]);

  const resolvedFor = (model: Model): ResolvedModel => resolveModel(draft?.view ?? connection!, model);

  // A manual output that fills the window would be rejected by the server.
  const orderErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    if (!connection || !draft) return errors;
    for (const model of connection.models) {
      const setting = draft.view.settings?.[model.id];
      if (!setting?.output) continue;
      const resolved = resolveModel(draft.view, model);
      if (resolved.output.value >= resolved.context.value)
        errors[fieldKey(model.id, "output")] = `必须小于上下文 ${formatTokens(resolved.context.value)}`;
    }
    return errors;
  }, [connection, draft]);

  const savedFallback = connection?.fallback ?? {};
  const fallbackDirty =
    (draft?.fallback.context ?? undefined) !== (savedFallback.context ?? undefined) ||
    (draft?.fallback.output ?? undefined) !== (savedFallback.output ?? undefined);
  const selectedDirty = !sameStringSet(selected, binding?.selected ?? []);
  const defaultDirty = (explicitDefault ?? null) !== (binding?.default ?? null);
  const hasChanges =
    selectedDirty || defaultDirty || fallbackDirty || alsoApply.length > 0 || collected.changes.length > 0;
  const hasErrors =
    Object.keys(collected.errors).length > 0 ||
    Object.keys(orderErrors).length > 0 ||
    Object.keys(draft?.fallbackErrors ?? {}).length > 0;
  const canRemove = Boolean(binding) && (binding!.selected.length > 0 || selected.length > 0);
  const canSave = Boolean(connection) && selected.length > 0 && hasChanges && !hasErrors && !saving && !busy;

  const sharedAgents = connection
    ? snapshot.bindings
        .filter((entry) => entry.connection === connection.id && entry.agent !== agent.id && entry.selected.length)
        .map((entry) => snapshot.agents.find((item) => item.id === entry.agent)?.label ?? entry.agent)
    : [];
  const syncCandidates = connection
    ? snapshot.agents.filter(
        (item) =>
          item.id !== agent.id && item.protocols.length > 0 && item.protocols.includes(connection.protocol),
      )
    : [];

  const requestClose = () => {
    if (saving) return;
    if (hasChanges) {
      setConfirmDiscard(true);
      return;
    }
    closeSheet();
  };

  const toggleModel = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };

  const setText = (key: string, value: string) => {
    setTexts((current) => ({ ...current, [key]: value }));
    setAcknowledged((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };

  const acceptSuggestion = (model: Model) => {
    const suggestion = model.suggested;
    if (!suggestion) return;
    setTexts((current) => {
      const next = { ...current };
      if (suggestion.context && !model.context && !next[fieldKey(model.id, "context")])
        next[fieldKey(model.id, "context")] = String(suggestion.context);
      if (suggestion.output && !model.output && !next[fieldKey(model.id, "output")])
        next[fieldKey(model.id, "output")] = String(suggestion.output);
      return next;
    });
  };

  const handleSave = async () => {
    if (!connection || !canSave || !draft) return;
    setSaving(true);
    // Selection, limits and capabilities are atomic: a selection must never be
    // generated with values the user is still editing.
    const ok = await run(
      {
        type: "selection",
        agent: agent.id,
        connection: connection.id,
        selected,
        ...(defaultDirty ? { default: explicitDefault } : {}),
        ...(collected.changes.length ? { changes: collected.changes } : {}),
        ...(fallbackDirty ? { fallback: draft.fallback } : {}),
        ...(alsoApply.length ? { alsoApply } : {}),
      },
      { key: "selection", toast: false, reload: false, errorPrefix: "保存模型配置失败" },
    );
    await reload();
    setSaving(false);
    if (ok) {
      toast.show(
        alsoApply.length
          ? `已更新 ${[agent.label, ...alsoApply.map((id) => snapshot.agents.find((a) => a.id === id)?.label ?? id)].join("、")} 的模型配置`
          : `已更新 ${agent.label} 的模型配置`,
        { variant: "success" },
      );
      closeSheet();
    }
  };

  const handleRemove = async () => {
    if (!connection) return;
    setSaving(true);
    const ok = await run(
      { type: "selection", agent: agent.id, connection: connection.id, selected: [] },
      { key: "selection", reload: true, errorPrefix: "清空模型选择失败" },
    );
    setSaving(false);
    setConfirmRemove(false);
    if (ok) {
      toast.show(`已清空 ${agent.label} 的模型选择`, { variant: "success" });
      closeSheet();
    }
  };

  if (!connection || !draft) return null;

  const allModels = connection.models;
  const missing = selected.filter((id) => !modelById(connection, id));
  const unlisted = selected
    .map((id) => modelById(connection, id))
    .filter((model): model is Model => model !== undefined && !model.listed);
  const nonChat = selected
    .map((id) => modelById(connection, id))
    .filter((model): model is Model => model !== undefined && !isChatModel(model));
  const pending = allModels.filter((model) => isChatModel(model) && resolvedFor(model).pending);
  const conflictCount = selected.reduce((count, id) => {
    const model = modelById(connection, id);
    return count + (model ? conflictsFor(connection, model).length : 0);
  }, 0);
  const effectiveDefault = defaultModelId(
    { selected, default: explicitDefault ?? undefined },
    connection,
  );
  const probeTargets = selected.filter((id) => {
    const model = modelById(connection, id);
    return model !== undefined && isChatModel(model);
  });
  const probing = busy === `probe:${connection.id}`;

  const issueModelIds = new Set<string>(missing);
  for (const model of allModels) {
    if (!selected.includes(model.id)) continue;
    if (
      conflictsFor(connection, model).length > 0 ||
      !model.listed ||
      !isChatModel(model) ||
      resolvedFor(model).pending ||
      connection.probes?.[model.id]?.ok === false
    )
      issueModelIds.add(model.id);
  }

  const normalizedQuery = query.trim().toLowerCase();
  const matches = (id: string, label: string) =>
    !normalizedQuery || id.toLowerCase().includes(normalizedQuery) || label.toLowerCase().includes(normalizedQuery);
  const visibleModels = allModels.filter((model) => {
    if (!matches(model.id, model.label)) return false;
    if (tab === "selected") return selected.includes(model.id);
    if (tab === "issues") return issueModelIds.has(model.id);
    return true;
  });
  const visibleMissing = missing.filter((id) => matches(id, "缺失模型"));
  const shownModels = visibleModels.slice(0, visibleLimit);
  const existingSelected = selected.filter((id) => Boolean(modelById(connection, id))).length;

  const probeNow = (ids: string[]) =>
    void run(
      { type: "probe", connection: connection.id, models: ids },
      { key: `probe:${connection.id}`, errorPrefix: "测试请求失败" },
    );

  const renderModel = (model: Model) => {
    const isSelected = selected.includes(model.id);
    const chat = isChatModel(model);
    const savedSelected = binding?.selected.includes(model.id) ?? false;
    const modelConflicts = conflictsFor(connection, model);
    const isExpanded = expanded.has(model.id);
    const resolved = resolvedFor(model);
    const probe = connection.probes?.[model.id];
    const isDefault = isSelected && effectiveDefault === model.id;
    const selectable = chat || isSelected;
    return (
      <View
        key={model.id}
        testID={`ppm-model-${model.id}`}
        style={{
          borderWidth: 1,
          borderColor: isSelected ? withAlpha(theme.colors.accent, 0.3) : theme.colors.border,
          backgroundColor: isSelected ? withAlpha(theme.colors.accent, 0.055) : theme.colors.surface1,
          borderRadius: 10,
          overflow: "hidden",
          opacity: chat ? 1 : 0.7,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 10 }}>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={`${isSelected ? "取消选择" : "选择"} ${model.label}`}
            accessibilityState={{ checked: isSelected, disabled: !selectable }}
            disabled={!selectable}
            onPress={() => toggleModel(model.id)}
            style={{ flexDirection: "row", alignItems: "center", gap: 9, flex: 1, minWidth: 0 }}
          >
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 5,
                borderWidth: 1.5,
                borderColor: isSelected ? theme.colors.accent : theme.colors.border,
                backgroundColor: isSelected ? theme.colors.accent : selectable ? "transparent" : theme.colors.surface2,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {isSelected ? <Icon name="Check" size={12} color={theme.colors.accentForeground} /> : null}
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <Text style={[t.bodyStrong, { flexShrink: 1 }]} numberOfLines={1}>
                  {model.label || model.id}
                </Text>
                {isDefault ? <Badge tone="accent" label="默认" icon="Star" /> : null}
                {model.fresh ? <Badge tone="accent" label="新" /> : null}
                {!chat ? <Badge tone="warning" label={`${KIND_LABELS[model.kind ?? "other"]} · 不能对话`} /> : null}
                {!model.listed ? <Badge tone="warning" label={isSelected ? "目录缺失" : "未列出"} /> : null}
                {chat && resolved.pending ? <Badge tone="warning" label="待确认" /> : null}
                {isSelected && !savedSelected ? <Badge label="待保存" /> : null}
                {modelConflicts.length > 0 ? (
                  <Badge tone="warning" label={`${modelConflicts.length} 个冲突`} icon="AlertTriangle" />
                ) : null}
                {probe ? (
                  <Badge
                    tone={probe.ok ? "success" : "danger"}
                    label={probe.ok ? `可用 ${((probe.ms ?? 0) / 1000).toFixed(1)}s` : "测试失败"}
                  />
                ) : null}
              </View>
              <Text style={t.mono} numberOfLines={1}>
                {model.id}
              </Text>
              {chat ? (
                <View style={{ flexDirection: "row", gap: 5, flexWrap: "wrap" }}>
                  <Badge
                    tone={resolved.context.source === "fallback" ? "neutral" : "accent"}
                    label={`上下文 ${formatTokens(resolved.context.value)} · ${sourceText(resolved.context.source, resolved.context.ref)}`}
                  />
                  <Badge
                    tone={resolved.output.source === "fallback" ? "neutral" : "accent"}
                    label={`输出 ${formatTokens(resolved.output.value)} · ${sourceText(resolved.output.source, resolved.output.ref)}${resolved.output.clamped ? " · 已压低" : ""}`}
                  />
                  {CAPABILITIES.filter(({ field }) => resolved.caps[field]).map(({ field, label }) => (
                    <Badge key={field} label={label} />
                  ))}
                </View>
              ) : null}
            </View>
          </Pressable>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
            {isSelected && chat && !isDefault ? (
              <IconBtn
                icon="Star"
                label={`设 ${model.id} 为默认模型`}
                onPress={() => setExplicitDefault(model.id)}
                testID={`ppm-default-${model.id}`}
              />
            ) : null}
            {chat ? (
              <IconBtn
                icon={isExpanded ? "ChevronDown" : "ChevronRight"}
                label={isExpanded ? "收起" : "展开上限与能力"}
                onPress={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(model.id)) next.delete(model.id);
                    else next.add(model.id);
                    return next;
                  })
                }
                testID={`ppm-limits-toggle-${model.id}`}
              />
            ) : null}
          </View>
        </View>

        {chat && isExpanded ? (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
              padding: 11,
              gap: 12,
              backgroundColor: theme.colors.surface0,
            }}
          >
            {!model.listed ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 11.5, lineHeight: 17 }}>
                网关已不再列出此模型。当前仍使用本地保存的参数，可继续使用或从选择中移除。
              </Text>
            ) : null}
            {resolved.pending && model.suggested ? (
              <Notice
                tone="warning"
                title="待确认的推荐值"
                action={<Btn label="采用" size="sm" variant="primary" onPress={() => acceptSuggestion(model)} />}
              >
                {model.suggested.context ? `上下文 ${formatTokensFull(model.suggested.context)}` : ""}
                {model.suggested.context && model.suggested.output ? " · " : ""}
                {model.suggested.output ? `输出 ${formatTokensFull(model.suggested.output)}` : ""}
                {`（${SUGGESTION_REASONS[model.suggested.reason]}${model.suggested.ref ? `，参考 ${model.suggested.ref}` : ""}）。确认前使用兜底值。`}
              </Notice>
            ) : null}
            {model.full && model.context && resolved.context.value !== model.full ? (
              <View style={[t.rowBetween, { gap: 8 }]}>
                <Text style={[t.tiny, { flex: 1 }]}>
                  完整窗口 {formatTokens(model.full)}：超过 {formatTokens(model.context.value)} 的部分单价翻倍，默认只用到{" "}
                  {formatTokens(model.context.value)}。
                </Text>
                <Btn
                  label={`改用 ${formatTokens(model.full)}`}
                  size="sm"
                  variant="ghost"
                  onPress={() => setText(fieldKey(model.id, "context"), String(model.full))}
                />
              </View>
            ) : null}
            {(["context", "output"] as const).map((field) => {
              const key = fieldKey(model.id, field);
              const override: Override | undefined = connection.settings?.[model.id]?.[field];
              const conflict = modelConflicts.find((entry) => entry.field === field);
              const text = texts[key] ?? "";
              const error = collected.errors[key] ?? (field === "output" ? orderErrors[key] : undefined);
              const capacity = model[field];
              const acknowledgedKey = acknowledged.has(key);
              const trimmed = text.trim();
              const parsed = trimmed ? parseTokens(trimmed) : {};
              const changedLocally =
                (trimmed === "" && override !== undefined) ||
                (parsed.value !== undefined && parsed.value !== override?.value);
              const showConflict = Boolean(conflict) && !acknowledgedKey && !changedLocally;
              const automatic = capacity
                ? `${formatTokens(capacity.value)} · ${capacity.source === "gateway" ? "网关" : capacity.ref ?? "目录"}`
                : `兜底 ${formatTokens(fallbackLimits(draft.view)[field])}`;
              return (
                <View key={field} style={{ gap: 6 }}>
                  <View style={t.rowBetween}>
                    <Text style={t.bodyStrong}>{field === "context" ? "上下文窗口" : "最大输出"}</Text>
                    <Text style={t.tiny}>自动 {automatic}</Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <TextField
                        value={text}
                        onChangeText={(value) => setText(key, value)}
                        placeholder={`留空使用自动值（${formatTokens(capacity?.value ?? fallbackLimits(draft.view)[field])}）`}
                        error={error}
                        editable={!saving}
                        testID={`ppm-limit-${model.id}-${field}`}
                      />
                    </View>
                    {override !== undefined || text ? (
                      <Btn label="恢复自动" size="sm" variant="ghost" onPress={() => setText(key, "")} disabled={saving} />
                    ) : null}
                  </View>
                  <Text style={t.tiny}>
                    生效 {formatTokens(resolved[field].value)} · {sourceText(resolved[field].source, resolved[field].ref)}
                    {resolved[field].clamped ? " · 自动值不小于上下文，已压低到 1/4" : ""}
                  </Text>
                  {showConflict && conflict ? (
                    <ConflictNotice
                      field={field}
                      conflict={conflict}
                      onKeep={() => {
                        setTexts((current) => ({ ...current, [key]: rawTokens(conflict.manual.value) }));
                        setAcknowledged((current) => new Set(current).add(key));
                      }}
                      onAccept={() => setText(key, "")}
                    />
                  ) : acknowledgedKey && conflict ? (
                    <Text style={{ color: theme.colors.statusSuccess, fontSize: 11.5, lineHeight: 17 }}>
                      保存后保留手动值，并确认最新自动值。
                    </Text>
                  ) : conflict && trimmed === "" && override !== undefined ? (
                    <Text style={{ color: theme.colors.statusSuccess, fontSize: 11.5, lineHeight: 17 }}>
                      保存后改用自动值。
                    </Text>
                  ) : null}
                </View>
              );
            })}
            <View style={{ gap: 6 }}>
              <Text style={t.bodyStrong}>能力</Text>
              {CAPABILITIES.map(({ field, label }) => {
                const manual = field in (caps[model.id] ?? {})
                  ? caps[model.id]![field]
                  : connection.settings?.[model.id]?.[field];
                const automatic = model.caps?.[field];
                const setCap = (value: boolean | undefined) =>
                  setCaps((current) => ({ ...current, [model.id]: { ...(current[model.id] ?? {}), [field]: value } }));
                return (
                  <View key={field} style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <Text style={[t.small, { width: 64 }]}>{label}</Text>
                    <Chip
                      label={`自动（${automatic === undefined ? (field === "tools" ? "默认是" : "默认否") : automatic ? "是" : "否"}）`}
                      selected={manual === undefined}
                      onPress={() => setCap(undefined)}
                      disabled={saving}
                    />
                    <Chip label="是" selected={manual === true} onPress={() => setCap(true)} disabled={saving} />
                    <Chip label="否" selected={manual === false} onPress={() => setCap(false)} disabled={saving} />
                  </View>
                );
              })}
            </View>
            {probe && !probe.ok ? (
              <View style={[t.rowBetween, { gap: 8 }]}>
                <Text style={{ color: theme.colors.statusDanger, fontSize: 11.5, lineHeight: 17, flex: 1 }}>
                  测试失败：{probe.error ?? "未知错误"}
                </Text>
                <Btn label="重测" size="sm" variant="ghost" onPress={() => probeNow([model.id])} pending={probing} />
              </View>
            ) : null}
            <Text style={t.tiny}>输入支持 128K、1.5M 等写法；留空表示使用自动值。上限和能力按连接共享。</Text>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
        title={`${connection.name} · 模型`}
        icon={<Icon name="ListChecks" size={18} color={theme.colors.accent} />}
        testID="ppm-model-sheet"
        footer={
          <>
            <View style={{ flex: 1, minWidth: 140 }}>
              <Text style={t.small}>
                已选 {existingSelected} / {allModels.length} 个模型
                {conflictCount ? ` · ${conflictCount} 个冲突` : ""}
                {missing.length + unlisted.length ? ` · ${missing.length + unlisted.length} 个缺失` : ""}
              </Text>
              {hasErrors ? (
                <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>请修正无效的上限值</Text>
              ) : selected.length === 0 ? (
                <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>至少选择一个模型，或清空选择</Text>
              ) : null}
            </View>
            {canRemove ? (
              <Btn
                label="清空选择"
                variant="danger"
                size="sm"
                icon="Unlink"
                onPress={() => setConfirmRemove(true)}
                disabled={!canRemove || saving || Boolean(busy)}
                testID="ppm-model-remove"
              />
            ) : null}
            <Btn label="取消" onPress={requestClose} disabled={saving} />
            <Btn
              label={saving ? "保存中…" : "保存"}
              variant="primary"
              icon="Check"
              onPress={() => void handleSave()}
              pending={saving}
              disabled={!canSave}
              testID="ppm-model-save"
            />
          </>
        }
      >
        <View
          style={{
            gap: 9,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            padding: 11,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <Icon name="Server" size={15} color={theme.colors.foregroundMuted} />
            <Badge tone="accent" label={protocolLabel(connection.protocol)} />
            {connection.catalogProvider ? <Badge label={`目录 ${connection.catalogProvider}`} /> : null}
            <Badge
              tone={connection.hasKey ? "success" : "warning"}
              label={connection.hasKey ? "已保存密钥" : "未保存密钥"}
            />
            {connection.error ? <Badge tone="danger" label="刷新失败" /> : null}
            <View style={{ flex: 1 }} />
            <Btn
              label={probing ? "测试中…" : `发送测试请求 · ${probeTargets.length} 个`}
              size="sm"
              variant="ghost"
              icon="Send"
              pending={probing}
              onPress={() => probeNow(probeTargets)}
              disabled={saving || probeTargets.length === 0 || (Boolean(busy) && !probing)}
              testID="ppm-probe"
            />
            <Btn
              label="编辑连接"
              size="sm"
              variant="ghost"
              icon="Pencil"
              onPress={() => {
                if (hasChanges) setConfirmEdit(true);
                else onEditConnection(connection);
              }}
              disabled={saving || Boolean(busy)}
            />
          </View>
          <Text style={t.mono} numberOfLines={2}>
            {connection.url}
          </Text>
          <Text style={t.tiny}>
            发送测试请求会给已选的对话模型各发一条极短请求（每个约几十 token），结果标在每一行。
          </Text>
          {connection.error ? (
            <Notice tone="danger" title="最近一次刷新失败">
              {connection.error}
            </Notice>
          ) : null}
        </View>

        <Notice tone="accent" title="上限和能力按连接共享">
          在这里修改的上下文、最大输出和能力会作用于这个连接上的所有 Agent
          {sharedAgents.length ? `（当前还有 ${sharedAgents.join("、")}）` : ""}。模型选择和默认模型属于 {agent.label}。
        </Notice>

        {pending.length ? (
          <Notice
            tone="warning"
            title={`${pending.length} 个模型有待确认的推荐值`}
            action={
              <Btn
                label="全部采用推荐值"
                size="sm"
                variant="primary"
                onPress={() => pending.forEach(acceptSuggestion)}
                testID="ppm-accept-all"
              />
            }
          >
            推测值或网上未公布的输出上限需要确认；确认前使用兜底值。采用后仍可逐个修改，保存后生效。
          </Notice>
        ) : null}

        {nonChat.length ? (
          <Notice
            tone="warning"
            title={`已选 ${nonChat.length} 个非对话模型`}
            action={
              <Btn
                label="全部移除"
                size="sm"
                variant="danger"
                onPress={() => setSelected((current) => current.filter((id) => !nonChat.some((m) => m.id === id)))}
              />
            }
          >
            {nonChat.map((model) => model.id).join("、")} 不能用于对话。
          </Notice>
        ) : null}

        <View style={{ gap: 6 }}>
          <Text style={t.bodyStrong}>兜底值</Text>
          <Text style={t.tiny}>网上查不到的模型使用这组值；留空为 128K / 16K。</Text>
          <View style={{ flexDirection: compact ? "column" : "row", gap: 8 }}>
            {(["context", "output"] as const).map((field) => (
              <View key={field} style={{ flex: 1 }}>
                <TextField
                  label={field === "context" ? "上下文窗口" : "最大输出"}
                  value={fallbackText[field]}
                  onChangeText={(value) => setFallbackText((current) => ({ ...current, [field]: value }))}
                  placeholder={field === "context" ? "128K" : "16K"}
                  error={draft.fallbackErrors[field]}
                  editable={!saving}
                  testID={`ppm-fallback-${field}`}
                />
              </View>
            ))}
          </View>
        </View>

        <View style={{ flexDirection: compact ? "column" : "row", gap: 8, alignItems: compact ? "stretch" : "center" }}>
          <SearchField value={query} onChangeText={setQuery} placeholder="搜索模型名称或 ID" testID="ppm-model-search" />
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Btn
              label="全选对话模型"
              size="sm"
              onPress={() =>
                setSelected((current) => {
                  const next = new Set(current);
                  for (const model of allModels) if (model.listed && isChatModel(model)) next.add(model.id);
                  return Array.from(next);
                })
              }
              disabled={saving}
            />
            <Btn label="清空" size="sm" variant="ghost" onPress={() => setSelected([])} disabled={saving || selected.length === 0} />
          </View>
        </View>

        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "all", label: "全部", count: allModels.length + missing.length },
            { value: "selected", label: "已选", count: selected.length },
            { value: "issues", label: "待处理", count: issueModelIds.size },
          ]}
          testID="ppm-model-tabs"
        />

        <View style={{ gap: 7 }}>
          {visibleMissing.map((id) => (
            <View
              key={`missing-${id}`}
              testID={`ppm-missing-${id}`}
              style={{
                borderWidth: 1,
                borderColor: withAlpha(theme.colors.statusWarning, 0.35),
                backgroundColor: withAlpha(theme.colors.statusWarning, 0.06),
                borderRadius: 10,
                padding: 10,
                flexDirection: "row",
                alignItems: "center",
                gap: 9,
              }}
            >
              <Icon name="TriangleAlert" size={16} color={theme.colors.statusWarning} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text style={t.bodyStrong} numberOfLines={1}>
                  缺失的模型
                </Text>
                <Text style={t.mono} numberOfLines={1}>
                  {id}
                </Text>
                <Text style={t.tiny}>连接刷新后不再提供此模型。移除后不会再出现在该 Agent 的配置中。</Text>
              </View>
              <Btn label="移除" size="sm" variant="danger" icon="X" onPress={() => toggleModel(id)} disabled={saving} />
            </View>
          ))}
          {shownModels.map(renderModel)}
          {visibleModels.length > shownModels.length ? (
            <View style={{ alignItems: "center", paddingTop: 2 }}>
              <Btn
                label={`显示更多（还剩 ${visibleModels.length - shownModels.length}）`}
                size="sm"
                variant="ghost"
                onPress={() => setVisibleLimit((current) => current + 80)}
              />
            </View>
          ) : null}
          {visibleModels.length === 0 && visibleMissing.length === 0 ? (
            <View style={{ paddingVertical: 22, alignItems: "center", gap: 4 }}>
              <Text style={t.h3}>{query ? "没有匹配的模型" : "没有可用的模型"}</Text>
              <Text style={[t.small, { textAlign: "center" }]}>
                {query
                  ? "换一个关键词，或清空搜索。"
                  : connection.models.length === 0
                    ? "刷新连接以获取模型目录，然后再选择模型。"
                    : tab === "selected"
                      ? "还没有选择模型。切换到“全部”开始选择。"
                      : tab === "issues"
                        ? "没有需要处理的模型。"
                        : "此连接没有返回模型。"}
              </Text>
            </View>
          ) : null}
        </View>

        {syncCandidates.length ? (
          <View style={{ gap: 6 }}>
            <Text style={t.bodyStrong}>同时应用到</Text>
            <Text style={t.tiny}>
              保存时把同一组模型和默认模型也应用到勾选的 Agent；之后它们仍可单独修改。
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
              {syncCandidates.map((item) => {
                const on = alsoApply.includes(item.id);
                const bound = snapshot.bindings.some(
                  (entry) => entry.agent === item.id && entry.connection === connection.id && entry.selected.length,
                );
                return (
                  <Chip
                    key={item.id}
                    label={bound ? `${item.label}（已接入）` : item.label}
                    icon={on ? "Check" : undefined}
                    selected={on}
                    onPress={() =>
                      setAlsoApply((current) =>
                        current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id],
                      )
                    }
                    disabled={saving}
                    testID={`ppm-also-${item.id}`}
                  />
                );
              })}
            </View>
          </View>
        ) : null}

        {allModels.length === 0 ? (
          <Notice tone="warning" title="模型目录为空">
            请返回连接卡片刷新该连接。如果刷新仍然没有模型，请检查网关地址与密钥。
          </Notice>
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={confirmDiscard}
        title="放弃未保存的更改？"
        description="模型选择、上限或能力还没有保存，关闭后将丢失这些修改。"
        confirmLabel="放弃更改"
        onConfirm={() => {
          setConfirmDiscard(false);
          closeSheet();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
      <ConfirmDialog
        open={confirmEdit}
        title="放弃未保存的修改并编辑连接？"
        description="当前模型选择、上限或能力还没有保存。编辑连接会先关闭此面板，未保存的修改将丢失。"
        confirmLabel="放弃并编辑"
        onConfirm={() => {
          setConfirmEdit(false);
          onEditConnection(connection);
        }}
        onCancel={() => setConfirmEdit(false)}
      />
      <ConfirmDialog
        open={confirmRemove}
        title="清空全部模型选择？"
        description={`将清空 ${agent.label} 对 ${connection.name} 的全部模型选择。连接、密钥、模型目录和上限设置都会保留，之后仍可重新选择模型。`}
        confirmLabel="清空选择"
        pending={saving}
        onConfirm={() => void handleRemove()}
        onCancel={() => setConfirmRemove(false)}
      />
    </>
  );
}

function ConflictNotice({
  field,
  conflict,
  onKeep,
  onAccept,
}: {
  field: LimitField;
  conflict: { manual: Override; automatic: number; acknowledged?: number };
  onKeep: () => void;
  onAccept: () => void;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  return (
    <View
      style={{
        gap: 7,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: withAlpha(theme.colors.statusWarning, 0.3),
        backgroundColor: withAlpha(theme.colors.statusWarning, 0.08),
        padding: 9,
      }}
    >
      <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
        <Icon name="AlertTriangle" size={14} color={theme.colors.statusWarning} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: theme.colors.statusWarning, fontSize: 12, fontWeight: "600" }}>
            {field === "context" ? "上下文" : "输出"}自动值已更新
          </Text>
          <Text style={t.tiny}>
            手动值 {formatTokensFull(conflict.manual.value)} · 最新自动值 {formatTokensFull(conflict.automatic)}
            {conflict.acknowledged !== undefined ? ` · 上次确认 ${formatTokensFull(conflict.acknowledged)}` : ""}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Btn label="保留手动" size="sm" variant="secondary" onPress={onKeep} />
        <Btn label="采用自动" size="sm" variant="primary" onPress={onAccept} />
      </View>
    </View>
  );
}
