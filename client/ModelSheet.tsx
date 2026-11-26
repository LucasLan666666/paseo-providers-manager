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
  count,
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
  useTr,
  withAlpha,
  type Translate,
} from "./ui";
import type { Lang } from "../shared/i18n";

type FilterTab = "all" | "selected" | "issues";
type CapsDraft = Record<string, Partial<Record<CapabilityField, boolean>>>;

const CAPABILITIES: Array<{ field: CapabilityField; label: (tr: Translate) => string; icon: string }> = [
  { field: "reasoning", label: (tr) => tr("推理", "Reasoning"), icon: "Brain" },
  { field: "image", label: (tr) => tr("图片输入", "Image input"), icon: "Image" },
  { field: "tools", label: (tr) => tr("工具调用", "Tool calls"), icon: "Wrench" },
];

function kindLabel(kind: ModelKind, tr: Translate): string {
  switch (kind) {
    case "chat":
      return tr("对话", "Chat");
    case "embedding":
      return tr("嵌入模型", "Embedding model");
    case "reranking":
      return tr("重排模型", "Reranking model");
    case "image":
      return tr("图像模型", "Image model");
    case "audio":
      return tr("语音模型", "Audio model");
    case "video":
      return tr("视频模型", "Video model");
    default:
      return tr("非对话模型", "Non-chat model");
  }
}

function suggestionReason(reason: "guess" | "output-unknown" | "loose", tr: Translate): string {
  if (reason === "guess") return tr("按同系列模型推测", "guessed from related models");
  if (reason === "output-unknown") return tr("网上没有公布输出上限", "the output limit is unpublished");
  return tr("只在第三方目录中找到", "found only in third-party catalogs");
}

// Model ids cannot contain NUL (server/adapter-common.ts MODEL_ID), unlike "::"
// which appears in Bedrock-style ARNs.
const KEY_SEPARATOR = "\u0000";

function fieldKey(model: string, field: LimitField): string {
  return `${model}${KEY_SEPARATOR}${field}`;
}

function sourceText(source: LimitSource, tr: Translate, ref?: string): string {
  if (source === "manual") return tr("手动", "manual");
  if (source === "gateway") return tr("网关", "gateway");
  if (source === "catalog") return ref ? tr("网上匹配", "matched online") : tr("目录", "catalog");
  return tr("兜底", "fallback");
}

/** Draft manual values as connection settings, so the shared resolver can preview them. */
function draftSettings(
  connection: Connection,
  texts: Record<string, string>,
  caps: CapsDraft,
  lang: Lang,
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
      const parsed = parseTokens(texts[key], lang);
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
  lang: Lang,
): { changes: SettingChange[]; errors: Record<string, string> } {
  const changes: SettingChange[] = [];
  const errors: Record<string, string> = {};
  for (const [key, raw] of Object.entries(texts)) {
    const [model, field] = key.split(KEY_SEPARATOR) as [string, LimitField];
    if (!modelById(connection, model)) continue;
    const initial = connection.settings?.[model]?.[field];
    const text = raw.trim();
    if (!text) {
      if (initial) changes.push({ model, field, value: null });
      continue;
    }
    const parsed = parseTokens(text, lang);
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
  const { tr, lang } = useTr();
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
      const parsed = parseTokens(fallbackText[field], lang);
      if (parsed.error) errors[field] = parsed.error;
      else if (parsed.value !== undefined) fallback[field] = parsed.value;
    }
    if (!errors.context && !errors.output && fallback.context && fallback.output && fallback.output >= fallback.context)
      errors.output = tr("兜底输出必须小于兜底上下文", "The fallback output must be smaller than the fallback context");
    return {
      view: { ...connection, fallback, settings: draftSettings(connection, texts, caps, lang) } as Connection,
      fallback,
      fallbackErrors: errors,
    };
  }, [connection, texts, caps, fallbackText, lang, tr]);

  const collected = useMemo(() => {
    if (!connection) return { changes: [], errors: {} };
    return collectChanges(connection, texts, caps, acknowledged, lang);
  }, [connection, texts, caps, acknowledged, lang]);

  const resolvedFor = (model: Model): ResolvedModel => resolveModel(draft?.view ?? connection!, model);

  // A manual output that fills the window would be rejected by the server for
  // the models this save generates or edits; other rows don't block saving.
  const orderErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    if (!connection || !draft) return errors;
    const edited = new Set(Object.keys(texts).map((key) => key.split(KEY_SEPARATOR)[0]));
    for (const model of connection.models) {
      if (!selected.includes(model.id) && !edited.has(model.id)) continue;
      const setting = draft.view.settings?.[model.id];
      if (!setting?.output) continue;
      const resolved = resolveModel(draft.view, model);
      if (resolved.output.value >= resolved.context.value)
        errors[fieldKey(model.id, "output")] = tr(
          `必须小于上下文 ${formatTokens(resolved.context.value)}`,
          `Must be smaller than the context ${formatTokens(resolved.context.value)}`,
        );
    }
    return errors;
  }, [connection, draft, selected, texts, tr]);

  // Open the rows whose values block saving, so the cause is visible.
  const errorModels = useMemo(
    () => [...Object.keys(orderErrors), ...Object.keys(collected.errors)].map((key) => key.split(KEY_SEPARATOR)[0]),
    [orderErrors, collected.errors],
  );
  useEffect(() => {
    if (!errorModels.length) return;
    setExpanded((current) => {
      if (errorModels.every((id) => current.has(id))) return current;
      const next = new Set(current);
      for (const id of errorModels) next.add(id);
      return next;
    });
  }, [errorModels]);

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
      { key: "selection", toast: false, reload: false, errorPrefix: tr("保存模型配置失败", "Saving the model settings failed") },
    );
    await reload();
    setSaving(false);
    if (ok) {
      toast.show(
        alsoApply.length
          ? tr(
              `已更新 ${[agent.label, ...alsoApply.map((id) => snapshot.agents.find((a) => a.id === id)?.label ?? id)].join("、")} 的模型配置`,
              `Updated the models of ${[agent.label, ...alsoApply.map((id) => snapshot.agents.find((a) => a.id === id)?.label ?? id)].join(", ")}`,
            )
          : tr(`已更新 ${agent.label} 的模型配置`, `Updated the models of ${agent.label}`),
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
      { key: "selection", reload: true, errorPrefix: tr("清空模型选择失败", "Clearing the model selection failed") },
    );
    setSaving(false);
    setConfirmRemove(false);
    if (ok) {
      toast.show(tr(`已清空 ${agent.label} 的模型选择`, `Cleared the models of ${agent.label}`), { variant: "success" });
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

  const issueModelIds = new Set<string>([...missing, ...errorModels]);
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
  const visibleMissing = missing.filter((id) => matches(id, tr("缺失模型", "missing model")));
  const shownModels = visibleModels.slice(0, visibleLimit);
  const existingSelected = selected.filter((id) => Boolean(modelById(connection, id))).length;

  const probeNow = (ids: string[]) =>
    void run(
      { type: "probe", connection: connection.id, models: ids },
      { key: `probe:${connection.id}`, errorPrefix: tr("测试请求失败", "The test request failed") },
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
            accessibilityLabel={isSelected ? tr(`取消选择 ${model.label}`, `Deselect ${model.label}`) : tr(`选择 ${model.label}`, `Select ${model.label}`)}
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
                {isDefault ? <Badge tone="accent" label={tr("默认", "Default")} icon="Star" /> : null}
                {model.fresh ? <Badge tone="accent" label={tr("新", "New")} /> : null}
                {!chat ? (
                  <Badge tone="warning" label={`${kindLabel(model.kind ?? "other", tr)} · ${tr("不能对话", "can't chat")}`} />
                ) : null}
                {!model.listed ? (
                  <Badge tone="warning" label={isSelected ? tr("目录缺失", "Missing from list") : tr("未列出", "Not listed")} />
                ) : null}
                {chat && resolved.pending ? <Badge tone="warning" label={tr("待确认", "To confirm")} /> : null}
                {isSelected && !savedSelected ? <Badge label={tr("待保存", "Unsaved")} /> : null}
                {modelConflicts.length > 0 ? (
                  <Badge tone="warning" label={tr(`${modelConflicts.length} 个冲突`, count(modelConflicts.length, "conflict", "conflicts"))} icon="AlertTriangle" />
                ) : null}
                {probe ? (
                  <Badge
                    tone={probe.ok ? "success" : "danger"}
                    label={
                      probe.ok
                        ? tr(`可用 ${((probe.ms ?? 0) / 1000).toFixed(1)}s`, `Works ${((probe.ms ?? 0) / 1000).toFixed(1)}s`)
                        : tr("测试失败", "Test failed")
                    }
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
                    label={`${tr("上下文", "Context")} ${formatTokens(resolved.context.value)} · ${sourceText(resolved.context.source, tr, resolved.context.ref)}`}
                  />
                  <Badge
                    tone={resolved.output.source === "fallback" ? "neutral" : "accent"}
                    label={`${tr("输出", "Output")} ${formatTokens(resolved.output.value)} · ${sourceText(resolved.output.source, tr, resolved.output.ref)}${resolved.output.clamped ? ` · ${tr("已压低", "lowered")}` : ""}`}
                  />
                  {CAPABILITIES.filter(({ field }) => resolved.caps[field]).map(({ field, label }) => (
                    <Badge key={field} label={label(tr)} />
                  ))}
                </View>
              ) : null}
            </View>
          </Pressable>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
            {isSelected && chat && !isDefault ? (
              <IconBtn
                icon="Star"
                label={tr(`设 ${model.id} 为默认模型`, `Make ${model.id} the default model`)}
                onPress={() => setExplicitDefault(model.id)}
                testID={`ppm-default-${model.id}`}
              />
            ) : null}
            {chat ? (
              <IconBtn
                icon={isExpanded ? "ChevronDown" : "ChevronRight"}
                label={isExpanded ? tr("收起", "Collapse") : tr("展开上限与能力", "Show limits and capabilities")}
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
                {tr(
                  "网关已不再列出此模型。当前仍使用本地保存的参数，可继续使用或从选择中移除。",
                  "The gateway no longer lists this model. The saved values still apply; keep it or remove it from the selection.",
                )}
              </Text>
            ) : null}
            {resolved.pending && model.suggested ? (
              <Notice
                tone="warning"
                title={tr("待确认的推荐值", "Suggested values to confirm")}
                action={<Btn label={tr("采用", "Adopt")} size="sm" variant="primary" onPress={() => acceptSuggestion(model)} />}
              >
                {model.suggested.context ? `${tr("上下文", "Context")} ${formatTokensFull(model.suggested.context)}` : ""}
                {model.suggested.context && model.suggested.output ? " · " : ""}
                {model.suggested.output ? `${tr("输出", "Output")} ${formatTokensFull(model.suggested.output)}` : ""}
                {tr(
                  `（${suggestionReason(model.suggested.reason, tr)}${model.suggested.ref ? `，参考 ${model.suggested.ref}` : ""}）。确认前使用兜底值。`,
                  ` (${suggestionReason(model.suggested.reason, tr)}${model.suggested.ref ? `, based on ${model.suggested.ref}` : ""}). Fallback values apply until you confirm.`,
                )}
              </Notice>
            ) : null}
            {model.full && model.context && resolved.context.value !== model.full ? (
              <View style={[t.rowBetween, { gap: 8 }]}>
                <Text style={[t.tiny, { flex: 1 }]}>
                  {tr(
                    `完整窗口 ${formatTokens(model.full)}：超过 ${formatTokens(model.context.value)} 的部分单价翻倍，默认只用到 ${formatTokens(model.context.value)}。`,
                    `Full window ${formatTokens(model.full)}: tokens beyond ${formatTokens(model.context.value)} cost twice as much, so ${formatTokens(model.context.value)} is used by default.`,
                  )}
                </Text>
                <Btn
                  label={tr(`改用 ${formatTokens(model.full)}`, `Use ${formatTokens(model.full)}`)}
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
              const parsed = trimmed ? parseTokens(trimmed, lang) : {};
              const changedLocally =
                (trimmed === "" && override !== undefined) ||
                (parsed.value !== undefined && parsed.value !== override?.value);
              const showConflict = Boolean(conflict) && !acknowledgedKey && !changedLocally;
              const automatic = capacity
                ? `${formatTokens(capacity.value)} · ${capacity.source === "gateway" ? tr("网关", "gateway") : capacity.ref ?? tr("目录", "catalog")}`
                : `${tr("兜底", "fallback")} ${formatTokens(fallbackLimits(draft.view)[field])}`;
              return (
                <View key={field} style={{ gap: 6 }}>
                  <View style={t.rowBetween}>
                    <Text style={t.bodyStrong}>{field === "context" ? tr("上下文窗口", "Context window") : tr("最大输出", "Max output")}</Text>
                    <Text style={t.tiny}>{tr("自动", "Automatic")} {automatic}</Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <TextField
                        value={text}
                        onChangeText={(value) => setText(key, value)}
                        placeholder={tr(
                          `留空使用自动值（${formatTokens(capacity?.value ?? fallbackLimits(draft.view)[field])}）`,
                          `Empty: automatic (${formatTokens(capacity?.value ?? fallbackLimits(draft.view)[field])})`,
                        )}
                        error={error}
                        editable={!saving}
                        testID={`ppm-limit-${model.id}-${field}`}
                      />
                    </View>
                    {override !== undefined || text ? (
                      <Btn label={tr("恢复自动", "Use automatic")} size="sm" variant="ghost" onPress={() => setText(key, "")} disabled={saving} />
                    ) : null}
                  </View>
                  <Text style={t.tiny}>
                    {tr("生效", "In effect")} {formatTokens(resolved[field].value)} · {sourceText(resolved[field].source, tr, resolved[field].ref)}
                    {resolved[field].clamped
                      ? tr(" · 自动值不小于上下文，已压低到 1/4", " · the automatic value reached the context, lowered to a quarter")
                      : ""}
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
                      {tr("保存后保留手动值，并确认最新自动值。", "Saving keeps the manual value and confirms the new automatic one.")}
                    </Text>
                  ) : conflict && trimmed === "" && override !== undefined ? (
                    <Text style={{ color: theme.colors.statusSuccess, fontSize: 11.5, lineHeight: 17 }}>
                      {tr("保存后改用自动值。", "Saving switches to the automatic value.")}
                    </Text>
                  ) : null}
                </View>
              );
            })}
            <View style={{ gap: 6 }}>
              <Text style={t.bodyStrong}>{tr("能力", "Capabilities")}</Text>
              {CAPABILITIES.map(({ field, label }) => {
                const manual = field in (caps[model.id] ?? {})
                  ? caps[model.id]![field]
                  : connection.settings?.[model.id]?.[field];
                const automatic = model.caps?.[field];
                const setCap = (value: boolean | undefined) =>
                  setCaps((current) => ({ ...current, [model.id]: { ...(current[model.id] ?? {}), [field]: value } }));
                return (
                  <View key={field} style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <Text style={[t.small, { width: 76 }]}>{label(tr)}</Text>
                    <Chip
                      label={tr(
                        `自动（${automatic === undefined ? (field === "tools" ? "默认是" : "默认否") : automatic ? "是" : "否"}）`,
                        `Auto (${automatic === undefined ? (field === "tools" ? "default yes" : "default no") : automatic ? "yes" : "no"})`,
                      )}
                      selected={manual === undefined}
                      onPress={() => setCap(undefined)}
                      disabled={saving}
                    />
                    <Chip label={tr("是", "Yes")} selected={manual === true} onPress={() => setCap(true)} disabled={saving} />
                    <Chip label={tr("否", "No")} selected={manual === false} onPress={() => setCap(false)} disabled={saving} />
                  </View>
                );
              })}
            </View>
            {probe && !probe.ok ? (
              <View style={[t.rowBetween, { gap: 8 }]}>
                <Text style={{ color: theme.colors.statusDanger, fontSize: 11.5, lineHeight: 17, flex: 1 }}>
                  {tr("测试失败：", "Test failed: ")}
                  {probe.kind === "timeout"
                    ? tr("请求超时", "request timed out")
                    : probe.kind === "unreachable"
                      ? tr("无法连接网关：", "cannot reach the gateway: ") + (probe.error ?? "")
                      : (probe.error ?? tr("未知错误", "unknown error"))}
                </Text>
                <Btn label={tr("重测", "Retest")} size="sm" variant="ghost" onPress={() => probeNow([model.id])} pending={probing} />
              </View>
            ) : null}
            <Text style={t.tiny}>
              {tr(
                "输入支持 128K、1.5M 等写法；留空表示使用自动值。上限和能力按连接共享。",
                "Values like 128K or 1.5M work; empty means automatic. Limits and capabilities are shared per connection.",
              )}
            </Text>
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
        title={`${connection.name} · ${tr("模型", "Models")}`}
        icon={<Icon name="ListChecks" size={18} color={theme.colors.accent} />}
        testID="ppm-model-sheet"
        footer={
          <>
            {/* Narrow screens: the summary takes its own row so the buttons stay together. */}
            <View style={compact ? { flexBasis: "100%" } : { flex: 1, minWidth: 140 }}>
              <Text style={t.small}>
                {tr(`已选 ${existingSelected} / ${allModels.length} 个模型`, `${existingSelected} / ${count(allModels.length, "model", "models")} selected`)}
                {conflictCount ? tr(` · ${conflictCount} 个冲突`, ` · ${count(conflictCount, "conflict", "conflicts")}`) : ""}
                {missing.length + unlisted.length
                  ? tr(` · ${missing.length + unlisted.length} 个缺失`, ` · ${missing.length + unlisted.length} missing`)
                  : ""}
              </Text>
              {hasErrors ? (
                <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>
                  {Object.keys(draft.fallbackErrors).length
                    ? tr("请修正兜底值", "Fix the fallback values")
                    : tr(
                        `请修正 ${new Set(errorModels).size} 个模型的上限值（见“待处理”）`,
                        `Fix the limits of ${count(new Set(errorModels).size, "model", "models")} (see “To review”)`,
                      )}
                </Text>
              ) : selected.length === 0 ? (
                <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>
                  {tr("至少选择一个模型，或清空选择", "Select at least one model, or clear the selection")}
                </Text>
              ) : null}
            </View>
            {canRemove ? (
              <Btn
                label={tr("清空选择", "Clear selection")}
                variant="danger"
                size="sm"
                icon="Unlink"
                onPress={() => setConfirmRemove(true)}
                disabled={!canRemove || saving || Boolean(busy)}
                testID="ppm-model-remove"
              />
            ) : null}
            <Btn label={tr("取消", "Cancel")} onPress={requestClose} disabled={saving} />
            <Btn
              label={saving ? tr("保存中…", "Saving…") : tr("保存", "Save")}
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
            {connection.catalogProvider ? (
              <Badge label={tr(`目录 ${connection.catalogProvider}`, `Catalog ${connection.catalogProvider}`)} />
            ) : null}
            <Badge
              tone={connection.hasKey ? "success" : "warning"}
              label={connection.hasKey ? tr("已保存密钥", "Key saved") : tr("未保存密钥", "No key")}
            />
            {connection.error ? <Badge tone="danger" label={tr("刷新失败", "Refresh failed")} /> : null}
            <View style={{ flex: 1 }} />
            <Btn
              label={
                probing
                  ? tr("测试中…", "Testing…")
                  : tr(`发送测试请求 · ${probeTargets.length} 个`, `Send test requests · ${probeTargets.length}`)
              }
              size="sm"
              variant="ghost"
              icon="Send"
              pending={probing}
              onPress={() => probeNow(probeTargets)}
              disabled={saving || probeTargets.length === 0 || (Boolean(busy) && !probing)}
              testID="ppm-probe"
            />
            <Btn
              label={tr("编辑连接", "Edit connection")}
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
            {tr(
              "发送测试请求会给已选的对话模型各发一条极短请求（每个约几十 token），结果标在每一行。",
              "Test requests send one tiny request to each selected chat model (a few dozen tokens each); results appear on each row.",
            )}
          </Text>
          {connection.error ? (
            <Notice tone="danger" title={tr("最近一次刷新失败", "The last refresh failed")}>
              {connection.error}
            </Notice>
          ) : null}
        </View>

        <Notice tone="accent" title={tr("上限和能力按连接共享", "Limits and capabilities are shared per connection")}>
          {tr(
            `在这里修改的上下文、最大输出和能力会作用于这个连接上的所有 Agent${sharedAgents.length ? `（当前还有 ${sharedAgents.join("、")}）` : ""}。模型选择和默认模型属于 ${agent.label}。`,
            `Context, max output and capability changes here apply to every agent on this connection${sharedAgents.length ? ` (also ${sharedAgents.join(", ")})` : ""}. The model selection and default model belong to ${agent.label}.`,
          )}
        </Notice>

        {pending.length ? (
          <Notice
            tone="warning"
            title={tr(`${pending.length} 个模型有待确认的推荐值`, `Suggested values to confirm: ${count(pending.length, "model", "models")}`)}
            action={
              <Btn
                label={tr("全部采用推荐值", "Adopt all suggestions")}
                size="sm"
                variant="primary"
                onPress={() => pending.forEach(acceptSuggestion)}
                testID="ppm-accept-all"
              />
            }
          >
            {tr(
              "推测值或网上未公布的输出上限需要确认；确认前使用兜底值。采用后仍可逐个修改，保存后生效。",
              "Guesses and unpublished output limits need confirmation; fallback values apply until then. You can still edit each value; changes apply when you save.",
            )}
          </Notice>
        ) : null}

        {nonChat.length ? (
          <Notice
            tone="warning"
            title={tr(`已选 ${nonChat.length} 个非对话模型`, `Selected but cannot chat: ${count(nonChat.length, "model", "models")}`)}
            action={
              <Btn
                label={tr("全部移除", "Remove all")}
                size="sm"
                variant="danger"
                onPress={() => setSelected((current) => current.filter((id) => !nonChat.some((m) => m.id === id)))}
              />
            }
          >
            {tr(
              `${nonChat.map((model) => model.id).join("、")} 不能用于对话。`,
              `${nonChat.map((model) => model.id).join(", ")} cannot be used for chat.`,
            )}
          </Notice>
        ) : null}

        <View style={{ gap: 6 }}>
          <Text style={t.bodyStrong}>{tr("兜底值", "Fallback values")}</Text>
          <Text style={t.tiny}>
            {tr("网上查不到的模型使用这组值；留空为 128K / 16K。", "Used for models no source knows; empty means 128K / 16K.")}
          </Text>
          <View style={{ flexDirection: compact ? "column" : "row", gap: 8 }}>
            {(["context", "output"] as const).map((field) => (
              <View key={field} style={{ flex: 1 }}>
                <TextField
                  label={field === "context" ? tr("上下文窗口", "Context window") : tr("最大输出", "Max output")}
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
          <SearchField value={query} onChangeText={setQuery} placeholder={tr("搜索模型名称或 ID", "Search model names or ids")} testID="ppm-model-search" />
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Btn
              label={tr("全选对话模型", "Select all chat models")}
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
            <Btn label={tr("清空", "Clear")} size="sm" variant="ghost" onPress={() => setSelected([])} disabled={saving || selected.length === 0} />
          </View>
        </View>

        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "all", label: tr("全部", "All"), count: allModels.length + missing.length },
            { value: "selected", label: tr("已选", "Selected"), count: selected.length },
            { value: "issues", label: tr("待处理", "To review"), count: issueModelIds.size },
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
                  {tr("缺失的模型", "Missing model")}
                </Text>
                <Text style={t.mono} numberOfLines={1}>
                  {id}
                </Text>
                <Text style={t.tiny}>
                  {tr(
                    "连接刷新后不再提供此模型。移除后不会再出现在该 Agent 的配置中。",
                    "The connection no longer offers this model. Removing it drops it from this agent's configuration.",
                  )}
                </Text>
              </View>
              <Btn label={tr("移除", "Remove")} size="sm" variant="danger" icon="X" onPress={() => toggleModel(id)} disabled={saving} />
            </View>
          ))}
          {shownModels.map(renderModel)}
          {visibleModels.length > shownModels.length ? (
            <View style={{ alignItems: "center", paddingTop: 2 }}>
              <Btn
                label={tr(
                  `显示更多（还剩 ${visibleModels.length - shownModels.length}）`,
                  `Show more (${visibleModels.length - shownModels.length} left)`,
                )}
                size="sm"
                variant="ghost"
                onPress={() => setVisibleLimit((current) => current + 80)}
              />
            </View>
          ) : null}
          {visibleModels.length === 0 && visibleMissing.length === 0 ? (
            <View style={{ paddingVertical: 22, alignItems: "center", gap: 4 }}>
              <Text style={t.h3}>{query ? tr("没有匹配的模型", "No matching models") : tr("没有可用的模型", "No models")}</Text>
              <Text style={[t.small, { textAlign: "center" }]}>
                {query
                  ? tr("换一个关键词，或清空搜索。", "Try another keyword, or clear the search.")
                  : connection.models.length === 0
                    ? tr("刷新连接以获取模型目录，然后再选择模型。", "Refresh the connection to load its models, then choose.")
                    : tab === "selected"
                      ? tr("还没有选择模型。切换到“全部”开始选择。", "No models selected yet. Switch to “All” to choose.")
                      : tab === "issues"
                        ? tr("没有需要处理的模型。", "Nothing to review.")
                        : tr("此连接没有返回模型。", "This connection returned no models.")}
              </Text>
            </View>
          ) : null}
        </View>

        {syncCandidates.length ? (
          <View style={{ gap: 6 }}>
            <Text style={t.bodyStrong}>{tr("同时应用到", "Also apply to")}</Text>
            <Text style={t.tiny}>
              {tr(
                "保存时把同一组模型和默认模型也应用到勾选的 Agent；之后它们仍可单独修改。",
                "Saving also gives the checked agents this model selection and default model; each can still be changed later.",
              )}
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
                    label={bound ? tr(`${item.label}（已接入）`, `${item.label} (connected)`) : item.label}
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
          <Notice tone="warning" title={tr("模型目录为空", "The model list is empty")}>
            {tr(
              "请返回连接卡片刷新该连接。如果刷新仍然没有模型，请检查网关地址与密钥。",
              "Refresh the connection from its card. If it still has no models, check the gateway URL and key.",
            )}
          </Notice>
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={confirmDiscard}
        title={tr("放弃未保存的更改？", "Discard unsaved changes?")}
        description={tr(
          "模型选择、上限或能力还没有保存，关闭后将丢失这些修改。",
          "The model selection, limits or capabilities are not saved; closing discards them.",
        )}
        confirmLabel={tr("放弃更改", "Discard")}
        onConfirm={() => {
          setConfirmDiscard(false);
          closeSheet();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
      <ConfirmDialog
        open={confirmEdit}
        title={tr("放弃未保存的修改并编辑连接？", "Discard changes and edit the connection?")}
        description={tr(
          "当前模型选择、上限或能力还没有保存。编辑连接会先关闭此面板，未保存的修改将丢失。",
          "The model selection, limits or capabilities are not saved. Editing the connection closes this sheet and discards them.",
        )}
        confirmLabel={tr("放弃并编辑", "Discard and edit")}
        onConfirm={() => {
          setConfirmEdit(false);
          onEditConnection(connection);
        }}
        onCancel={() => setConfirmEdit(false)}
      />
      <ConfirmDialog
        open={confirmRemove}
        title={tr("清空全部模型选择？", "Clear the whole model selection?")}
        description={tr(
          `将清空 ${agent.label} 对 ${connection.name} 的全部模型选择。连接、密钥、模型目录和上限设置都会保留，之后仍可重新选择模型。`,
          `This clears every model ${agent.label} uses from ${connection.name}. The connection, key, model list and limits stay; you can choose models again later.`,
        )}
        confirmLabel={tr("清空选择", "Clear selection")}
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
  const { tr } = useTr();
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
            {field === "context"
              ? tr("上下文自动值已更新", "The automatic context changed")
              : tr("输出自动值已更新", "The automatic output changed")}
          </Text>
          <Text style={t.tiny}>
            {tr("手动值", "Manual")} {formatTokensFull(conflict.manual.value)} · {tr("最新自动值", "new automatic")}{" "}
            {formatTokensFull(conflict.automatic)}
            {conflict.acknowledged !== undefined
              ? ` · ${tr("上次确认", "last confirmed")} ${formatTokensFull(conflict.acknowledged)}`
              : ""}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Btn label={tr("保留手动", "Keep manual")} size="sm" variant="secondary" onPress={onKeep} />
        <Btn label={tr("采用自动", "Use automatic")} size="sm" variant="primary" onPress={onAccept} />
      </View>
    </View>
  );
}
