import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Action, Binding, Connection, Limits, Model, Override } from "../shared/contracts";
import {
  conflictsFor,
  modelById,
  type AgentDescriptor,
  type LimitField,
  type LimitSource,
} from "./derive";
import {
  formatTokens,
  formatTokensFull,
  parseTokens,
  protocolLabel,
  rawTokens,
  sameStringSet,
  sourceLabel,
} from "./format";
import type { RunOptions } from "./useManager";
import {
  Badge,
  Btn,
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

interface DraftChange {
  model: string;
  field: LimitField;
  value: number | null;
}

type FilterTab = "all" | "selected" | "issues";

function fieldKey(model: string, field: LimitField): string {
  return `${model}::${field}`;
}

function collectChanges(
  selected: readonly string[],
  texts: Record<string, string>,
  binding: Binding | undefined,
  connection: Connection,
  acknowledged: ReadonlySet<string>,
): { changes: DraftChange[]; errors: Record<string, string> } {
  const changes: DraftChange[] = [];
  const errors: Record<string, string> = {};
  for (const id of selected) {
    const model = modelById(connection, id);
    if (!model) continue;
    for (const field of ["context", "output"] as const) {
      const key = fieldKey(id, field);
      const text = (texts[key] ?? "").trim();
      const initial = binding?.overrides[id]?.[field];
      if (!text) {
        if (initial !== undefined) changes.push({ model: id, field, value: null });
        continue;
      }
      const parsed = parseTokens(text);
      if (parsed.error) {
        errors[key] = parsed.error;
        continue;
      }
      if (parsed.value === undefined) continue;
      if (initial?.value !== parsed.value || acknowledged.has(key)) {
        changes.push({ model: id, field, value: parsed.value });
      }
    }
  }
  return { changes, errors };
}

function draftEffective(
  model: Model,
  field: LimitField,
  text: string,
  defaults: Limits | undefined,
): { value?: number; source?: LimitSource } {
  const trimmed = text.trim();
  if (trimmed) {
    const parsed = parseTokens(trimmed);
    if (parsed.value !== undefined) return { value: parsed.value, source: "manual" };
  }
  const capacity = model[field];
  if (capacity) return { value: capacity.value, source: capacity.source };
  const fallback = defaults?.[field];
  if (fallback) return { value: fallback, source: "default" };
  return {};
}

function sourceText(source: LimitSource | undefined): string {
  if (source === "manual") return "手动";
  if (source === "gateway") return "网关";
  if (source === "catalog") return "目录";
  if (source === "default") return "默认";
  return "未设置";
}

export function ModelSheet({
  open,
  agent,
  connection,
  binding,
  defaults,
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
  defaults: Limits | undefined;
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
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<FilterTab>("all");
  const [visibleLimit, setVisibleLimit] = useState(80);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmEdit, setConfirmEdit] = useState(false);

  useEffect(() => {
    if (!open || !connection) return;
    const initialSelected = binding?.selected ?? [];
    setSelected([...initialSelected]);
    const nextTexts: Record<string, string> = {};
    const nextExpanded = new Set<string>();
    // Load every retained override, not only the currently selected models:
    // reselecting a model must not erase a manual value it still carries.
    for (const [id, entry] of Object.entries(binding?.overrides ?? {})) {
      for (const field of ["context", "output"] as const) {
        nextTexts[fieldKey(id, field)] = rawTokens(entry[field]?.value);
      }
    }
    for (const id of initialSelected) {
      const model = modelById(connection, id);
      if (!model) continue;
      if (conflictsFor(binding, model).length > 0) nextExpanded.add(id);
    }
    setTexts(nextTexts);
    setAcknowledged(new Set());
    setExpanded(nextExpanded);
    setQuery("");
    setTab("all");
    setVisibleLimit(80);
    setSaving(false);
    setConfirmDiscard(false);
    setConfirmRemove(false);
    setConfirmEdit(false);
  }, [open, connection?.id]);

  const overrideChanges = useMemo(() => {
    if (!connection) return { changes: [], errors: {} };
    return collectChanges(selected, texts, binding, connection, acknowledged);
  }, [selected, texts, binding, connection, acknowledged]);

  const selectedDirty = !sameStringSet(selected, binding?.selected ?? []);
  const hasChanges = selectedDirty || overrideChanges.changes.length > 0;
  const hasErrors = Object.keys(overrideChanges.errors).length > 0;
  const canRemove = Boolean(binding) && (binding!.selected.length > 0 || selected.length > 0);
  const canSave =
    Boolean(connection) &&
    selected.length > 0 &&
    hasChanges &&
    !hasErrors &&
    !saving &&
    !busy;

  const missing = connection
    ? selected.filter((id) => !modelById(connection, id))
    : [];
  const unlisted = connection
    ? selected
        .map((id) => modelById(connection, id))
        .filter((model): model is Model => model !== undefined && !model.listed)
    : [];
  const conflicts = useMemo(() => {
    if (!binding || !connection) return 0;
    let count = 0;
    for (const id of selected) {
      const model = modelById(connection, id);
      if (model) count += conflictsFor(binding, model).length;
    }
    return count;
  }, [binding, connection, selected]);

  const requestClose = () => {
    if (saving) return;
    if (hasChanges) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const toggleModel = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };

  const handleSave = async () => {
    if (!connection || !canSave) return;
    setSaving(true);
    // Selection and limit changes must be atomic: agents such as Pi reject a
    // selection whose models still lack limits, so the overrides travel with it.
    const ok = await run(
      {
        type: "selection",
        agent: agent.id,
        connection: connection.id,
        selected,
        changes: overrideChanges.changes,
      },
      { key: "selection", toast: false, reload: false, errorPrefix: "保存模型配置失败" },
    );
    await reload();
    setSaving(false);
    if (ok) {
      toast.show(`已更新 ${agent.label} 的模型配置`, { variant: "success" });
      onClose();
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
      onClose();
    }
  };

  if (!connection) return null;

  const allModels = connection.models;
  const issueModelIds = new Set<string>(missing);
  if (binding) {
    for (const model of allModels) {
      if (!selected.includes(model.id)) continue;
      if (conflictsFor(binding, model).length > 0 || !model.listed) {
        issueModelIds.add(model.id);
      }
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const matches = (id: string, label: string) =>
    !normalizedQuery ||
    id.toLowerCase().includes(normalizedQuery) ||
    label.toLowerCase().includes(normalizedQuery);

  const visibleModels = allModels.filter((model) => {
    if (!matches(model.id, model.label)) return false;
    if (tab === "selected") return selected.includes(model.id);
    if (tab === "issues") return issueModelIds.has(model.id);
    return true;
  });
  const visibleMissing = missing.filter(
    (id) =>
      matches(id, "缺失模型") &&
      (tab === "all" || tab === "selected" || tab === "issues"),
  );
  const shownModels = visibleModels.slice(0, visibleLimit);

  const existingSelected = selected.filter((id) => Boolean(modelById(connection, id))).length;

  const renderModel = (model: Model) => {
    const isSelected = selected.includes(model.id);
    const savedSelected = binding?.selected.includes(model.id) ?? false;
    const modelConflicts = conflictsFor(binding, model);
    const isExpanded = expanded.has(model.id);
    return (
      <View
        key={model.id}
        testID={`ppm-model-${model.id}`}
        style={{
          borderWidth: 1,
          borderColor: isSelected ? withAlpha(theme.colors.accent, 0.3) : theme.colors.border,
          backgroundColor: isSelected
            ? withAlpha(theme.colors.accent, 0.055)
            : theme.colors.surface1,
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 10 }}>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={`${isSelected ? "取消选择" : "选择"} ${model.label}`}
            accessibilityState={{ checked: isSelected }}
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
                backgroundColor: isSelected ? theme.colors.accent : "transparent",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {isSelected ? (
                <Icon name="Check" size={12} color={theme.colors.accentForeground} />
              ) : null}
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <Text style={[t.bodyStrong, { flexShrink: 1 }]} numberOfLines={1}>
                  {model.label || model.id}
                </Text>
                {!model.listed ? (
                  <Badge tone="warning" label={isSelected ? "目录缺失" : "未列出"} />
                ) : null}
                {isSelected && !savedSelected ? <Badge label="待保存" /> : null}
                {modelConflicts.length > 0 ? (
                  <Badge tone="warning" label={`${modelConflicts.length} 个冲突`} icon="AlertTriangle" />
                ) : null}
              </View>
              <Text style={t.mono} numberOfLines={1}>
                {model.id}
              </Text>
              <View style={{ flexDirection: "row", gap: 5, flexWrap: "wrap" }}>
                <CapacityChip field="context" model={model} />
                <CapacityChip field="output" model={model} />
              </View>
            </View>
          </Pressable>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
            {isSelected ? (
              <IconBtn
                icon={isExpanded ? "ChevronDown" : "ChevronRight"}
                label={isExpanded ? "收起限额" : "展开限额"}
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

        {isSelected && isExpanded ? (
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
            {(["context", "output"] as const).map((field) => {
              const key = fieldKey(model.id, field);
              const override = binding?.overrides[model.id]?.[field];
              const conflict = modelConflicts.find((entry) => entry.field === field);
              const text = texts[key] ?? "";
              const error = overrideChanges.errors[key];
              const effective = draftEffective(model, field, text, defaults);
              const capacity = model[field];
              const acknowledgedKey = acknowledged.has(key);
              const trimmed = text.trim();
              const parsed = trimmed ? parseTokens(trimmed) : {};
              const changedLocally =
                (trimmed === "" && override !== undefined) ||
                (parsed.value !== undefined && parsed.value !== override?.value);
              const showConflict = Boolean(conflict) && !acknowledgedKey && !changedLocally;
              return (
                <View key={field} style={{ gap: 6 }}>
                  <View style={t.rowBetween}>
                    <Text style={t.bodyStrong}>{field === "context" ? "上下文" : "输出"}</Text>
                    <Text style={t.tiny}>
                      自动 {capacity ? `${formatTokens(capacity.value)} · ${sourceLabel(capacity.source)}` : "未知"}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <TextField
                        value={text}
                        onChangeText={(value) => {
                          setTexts((current) => ({ ...current, [key]: value }));
                          setAcknowledged((current) => {
                            if (!current.has(key)) return current;
                            const next = new Set(current);
                            next.delete(key);
                            return next;
                          });
                        }}
                        placeholder={capacity ? `自动 ${formatTokens(capacity.value)}` : "留空使用默认值"}
                        error={error}
                        editable={!saving}
                        testID={`ppm-limit-${model.id}-${field}`}
                      />
                    </View>
                    {override !== undefined || text ? (
                      <Btn
                        label="恢复自动"
                        size="sm"
                        variant="ghost"
                        onPress={() => {
                          setTexts((current) => ({ ...current, [key]: "" }));
                          setAcknowledged((current) => {
                            if (!current.has(key)) return current;
                            const next = new Set(current);
                            next.delete(key);
                            return next;
                          });
                        }}
                        disabled={saving}
                      />
                    ) : null}
                  </View>
                  <Text style={t.tiny}>
                    生效 {formatTokens(effective.value)} · {sourceText(effective.source)}
                    {override ? ` · 手动覆盖 ${formatTokens(override.value)}` : ""}
                  </Text>
                  {showConflict && conflict ? (
                    <ConflictNotice
                      field={field}
                      conflict={conflict}
                      onKeep={() => {
                        setTexts((current) => ({ ...current, [key]: rawTokens(conflict.manual.value) }));
                        setAcknowledged((current) => new Set(current).add(key));
                      }}
                      onAccept={() => {
                        setTexts((current) => ({ ...current, [key]: "" }));
                        setAcknowledged((current) => {
                          if (!current.has(key)) return current;
                          const next = new Set(current);
                          next.delete(key);
                          return next;
                        });
                      }}
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
            <Text style={t.tiny}>
              提示：输入支持 128K、1.5M 等写法；留空表示恢复自动值。
            </Text>
          </View>
        ) : null}
      </View>
    );
  };

  const title = `${connection.name} · 模型`;
  const testing = busy === `testConnection:${connection.id}`;
  const overrideCount = selected.reduce((count, id) => {
    const entry = binding?.overrides[id];
    return count + (entry?.context ? 1 : 0) + (entry?.output ? 1 : 0);
  }, 0);

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
        title={title}
        icon={<Icon name="ListChecks" size={18} color={theme.colors.accent} />}
        testID="ppm-model-sheet"
        footer={
          <>
            <View style={{ flex: 1, minWidth: 140 }}>
              <Text style={t.small}>
                已选 {existingSelected} / {allModels.length} 个模型
                {overrideCount ? ` · ${overrideCount} 个手动值` : ""}
                {conflicts ? ` · ${conflicts} 个冲突` : ""}
                {missing.length + unlisted.length ? ` · ${missing.length + unlisted.length} 个缺失` : ""}
              </Text>
              {hasErrors ? (
                <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>
                  请修正无效的限额值
                </Text>
              ) : selected.length === 0 ? (
                <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>
                  至少选择一个模型，或清空选择
                </Text>
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
            {connection.catalogProvider ? (
              <Badge label={`目录 ${connection.catalogProvider}`} />
            ) : null}
            <Badge
              tone={connection.hasKey ? "success" : "warning"}
              label={connection.hasKey ? "已保存密钥" : "未保存密钥"}
            />
            {connection.error ? <Badge tone="danger" label="刷新失败" /> : null}
            <View style={{ flex: 1 }} />
            <Btn
              label={testing ? "测试中…" : "测试全部模型"}
              size="sm"
              variant="ghost"
              icon="Activity"
              pending={testing}
              onPress={() =>
                void run(
                  { type: "testConnection", connection: connection.id },
                  {
                    key: `testConnection:${connection.id}`,
                    errorPrefix: "测试失败",
                  },
                )
              }
              disabled={saving || (Boolean(busy) && !testing)}
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
          {connection.error ? (
            <Notice tone="danger" title="最近一次刷新失败">
              {connection.error}
            </Notice>
          ) : null}
        </View>

        <View style={{ flexDirection: compact ? "column" : "row", gap: 8, alignItems: compact ? "stretch" : "center" }}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder="搜索模型名称或 ID"
            testID="ppm-model-search"
          />
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Btn
              label="全选已列出"
              size="sm"
              onPress={() =>
                setSelected((current) => {
                  const next = new Set(current);
                  for (const model of allModels) if (model.listed) next.add(model.id);
                  return Array.from(next);
                })
              }
              disabled={saving}
            />
            <Btn
              label="全选"
              size="sm"
              onPress={() =>
                setSelected((current) => {
                  const next = new Set(current);
                  for (const model of allModels) next.add(model.id);
                  return Array.from(next);
                })
              }
              disabled={saving}
            />
            <Btn
              label="清空"
              size="sm"
              variant="ghost"
              onPress={() => setSelected([])}
              disabled={saving || selected.length === 0}
            />
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
              <Btn
                label="移除"
                size="sm"
                variant="danger"
                icon="X"
                onPress={() => toggleModel(id)}
                disabled={saving}
              />
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
                        ? "没有冲突或缺失的模型。"
                        : "此连接没有返回模型。"}
              </Text>
            </View>
          ) : null}
        </View>

        {allModels.length === 0 ? (
          <Notice tone="warning" title="模型目录为空">
            请返回连接卡片刷新该连接。如果刷新仍然没有模型，请检查网关地址与密钥。
          </Notice>
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={confirmDiscard}
        title="放弃未保存的更改？"
        description="模型选择或手动限额还没有保存，关闭后将丢失这些修改。"
        confirmLabel="放弃更改"
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
      <ConfirmDialog
        open={confirmEdit}
        title="放弃未保存的修改并编辑连接？"
        description="当前模型选择或手动限额还没有保存。编辑连接会先关闭此面板，未保存的模型修改将丢失。"
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
        description={`将清空 ${agent.label} 对 ${connection.name} 的全部模型选择。连接绑定、密钥与模型目录都会保留，之后仍可重新选择模型。`}
        confirmLabel="清空选择"
        pending={saving}
        onConfirm={() => void handleRemove()}
        onCancel={() => setConfirmRemove(false)}
      />
    </>
  );
}

function CapacityChip({ field, model }: { field: LimitField; model: Model }) {
  const { theme } = useLayout();
  const capacity = model[field];
  if (!capacity) {
    return <Badge label={`${field === "context" ? "上下文" : "输出"} 未知`} />;
  }
  return (
    <Badge
      tone={capacity.source === "gateway" ? "accent" : "neutral"}
      label={`${field === "context" ? "上下文" : "输出"} ${formatTokens(capacity.value)} · ${
        capacity.source === "gateway" ? "网关" : "目录"
      }`}
    />
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
            手动值 {formatTokensFull(conflict.manual.value)} · 最新自动值{" "}
            {formatTokensFull(conflict.automatic)}
            {conflict.acknowledged !== undefined
              ? ` · 上次确认 ${formatTokensFull(conflict.acknowledged)}`
              : ""}
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
