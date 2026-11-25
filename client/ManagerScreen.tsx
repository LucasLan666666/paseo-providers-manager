import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  agentIds,
  type Action,
  type AgentId,
  type Connection,
  type Protocol,
  type Snapshot,
} from "../shared/contracts";
import { AgentRail } from "./AgentRail";
import { AgentView } from "./AgentView";
import { ConnectionForm } from "./ConnectionForm";
import { ConnectionLibrary } from "./ConnectionLibrary";
import { agentsUsing, bindingFor, connectionById } from "./derive";
import { protocolLabel } from "./format";
import { ModelSheet } from "./ModelSheet";
import {
  readScreenMemory,
  rememberAgent,
  rememberForm,
  rememberModelConnection,
  rememberView,
  type FormPreset,
  type ScreenForm,
  type ScreenView,
} from "./screenState";
import { useManager } from "./useManager";
import {
  Btn,
  Card,
  ConfirmDialog,
  EmptyState,
  IconBtn,
  Notice,
  Segmented,
  UiProvider,
  useLayout,
  useTokens,
} from "./ui";

interface BootState {
  view: ScreenView;
  agentId: AgentId | null;
  modelConnectionId: string | null;
  form: ScreenForm | null;
}

function createBoot(params: PluginScreenProps["params"]): BootState {
  const memory = readScreenMemory();
  const requestedAgent =
    params.agent && agentIds.includes(params.agent as AgentId)
      ? (params.agent as AgentId)
      : null;
  const agentId = requestedAgent ?? memory.agentId;
  // Explicit deep-link params win over a remembered panel from another agent.
  const preservePanels = !requestedAgent || requestedAgent === memory.agentId;
  return {
    view:
      params.view === "library" || params.view === "agents"
        ? params.view
        : memory.view,
    agentId,
    modelConnectionId: preservePanels ? memory.modelConnectionId : null,
    form: preservePanels ? memory.form : null,
  };
}

export function ManagerScreen(props: PluginScreenProps) {
  return (
    <UiProvider theme={props.theme} compact={props.layout.compact}>
      <Manager {...props} />
    </UiProvider>
  );
}

function Manager(props: PluginScreenProps) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  const manager = useManager();
  const { snapshot, loading, loadError, busy, autoRefreshing, autoRefreshError } = manager;

  const bootRef = useRef<BootState | null>(null);
  if (!bootRef.current) bootRef.current = createBoot(props.params);
  const boot = bootRef.current;

  const [view, setView] = useState<ScreenView>(boot.view);
  const [agentId, setAgentId] = useState<AgentId | null>(boot.agentId);
  const [modelConnectionId, setModelConnectionId] = useState<string | null>(
    boot.modelConnectionId,
  );
  const [form, setForm] = useState<ScreenForm | null>(boot.form);
  const [deleteTarget, setDeleteTarget] = useState<Connection | null>(null);
  const [autoErrorDismissed, setAutoErrorDismissed] = useState(false);

  const activeAgentId = agentId ?? snapshot?.agents[0]?.id ?? null;
  const descriptor =
    snapshot?.agents.find((agent) => agent.id === activeAgentId) ?? null;
  const formConnection =
    snapshot && form?.kind === "edit"
      ? connectionById(snapshot, form.connectionId) ?? null
      : null;
  const formActive =
    form?.kind === "create" || (form?.kind === "edit" && Boolean(formConnection));
  const formOrigin = form?.origin
    ? snapshot?.agents.find((agent) => agent.id === form.origin)
    : undefined;

  useEffect(() => {
    setAutoErrorDismissed(false);
  }, [autoRefreshError]);

  useEffect(() => {
    if (activeAgentId) rememberAgent(activeAgentId);
  }, [activeAgentId]);

  useEffect(() => {
    rememberView(view);
  }, [view]);

  useEffect(() => {
    rememberModelConnection(modelConnectionId);
  }, [modelConnectionId]);

  useEffect(() => {
    rememberForm(form);
  }, [form]);

  useEffect(() => {
    if (!snapshot) return;
    if (agentId && snapshot.agents.some((agent) => agent.id === agentId)) return;
    const requested = props.params.agent;
    const requestedValid =
      requested && snapshot.agents.some((agent) => agent.id === requested)
        ? (requested as AgentId)
        : null;
    setAgentId(requestedValid ?? snapshot.agents[0]?.id ?? null);
  }, [snapshot, agentId, props.params.agent]);

  useEffect(() => {
    if (!snapshot || !modelConnectionId) return;
    if (!connectionById(snapshot, modelConnectionId)) {
      setModelConnectionId(null);
      rememberModelConnection(null);
    }
  }, [snapshot, modelConnectionId]);

  useEffect(() => {
    if (!snapshot || form?.kind !== "edit") return;
    if (!connectionById(snapshot, form.connectionId)) {
      setForm(null);
      rememberForm(null);
    }
  }, [snapshot, form]);

  const modelConnection = snapshot ? connectionById(snapshot, modelConnectionId ?? "") : undefined;
  const modelBinding =
    snapshot && descriptor && modelConnection
      ? bindingFor(snapshot, descriptor.id, modelConnection.id)
      : undefined;

  const closeModels = () => {
    setModelConnectionId(null);
    rememberModelConnection(null);
  };

  const closeForm = () => {
    setForm(null);
    rememberForm(null);
  };

  const openModels = (connection: Connection) => {
    closeForm();
    setModelConnectionId(connection.id);
    rememberModelConnection(connection.id);
  };

  const selectAgent = (next: AgentId) => {
    setAgentId(next);
    rememberAgent(next);
    setView("agents");
    rememberView("agents");
    closeModels();
    closeForm();
  };

  const changeView = (next: ScreenView) => {
    setView(next);
    rememberView(next);
  };

  // `origin` is set only when an agent's page opens the form; the top bar and
  // the library never imply a "current agent".
  const openCreate = (origin?: AgentId, preset?: FormPreset) => {
    closeModels();
    const next: ScreenForm = { kind: "create", origin, preset };
    setForm(next);
    rememberForm(next);
  };

  const openEdit = (connection: Connection, origin?: AgentId, preset?: FormPreset) => {
    closeModels();
    const next: ScreenForm = { kind: "edit", connectionId: connection.id, origin, preset };
    setForm(next);
    rememberForm(next);
  };

  const copyPreset = (connection: Connection, protocol?: Protocol): FormPreset => ({
    protocol,
    name: protocol ? `${connection.name} (${protocolLabel(protocol)})` : `${connection.name} 副本`,
    url: connection.url,
    catalogProvider: connection.catalogProvider,
    copyFrom: connection.id,
  });

  // After a form opened from an agent page saves, continue straight to choosing
  // that agent's models on the connection — but only if that agent can use the
  // saved protocol; otherwise the sheet would offer models it cannot save.
  const afterSave = (
    origin: AgentId | undefined,
    connectionId: string | undefined,
    protocol: Protocol,
  ) => {
    if (!origin || !connectionId) return;
    const agent = snapshot?.agents.find((item) => item.id === origin);
    if (!agent?.protocols.includes(protocol)) return;
    setAgentId(origin);
    rememberAgent(origin);
    setView("agents");
    rememberView("agents");
    setModelConnectionId(connectionId);
    rememberModelConnection(connectionId);
  };

  const refreshConnection = (connection: Connection) => {
    void manager.run(
      { type: "refresh", connection: connection.id },
      { key: `refresh:${connection.id}`, errorPrefix: "刷新连接失败" },
    );
  };

  const testConnection = (connection: Connection) => {
    void manager.run(
      { type: "testConnection", connection: connection.id },
      { key: `testConnection:${connection.id}`, errorPrefix: "测试失败" },
    );
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const ok = await manager.run(
      { type: "deleteConnection", connection: target.id },
      { key: "deleteConnection", errorPrefix: "删除连接失败" },
    );
    if (!ok) return;
    setDeleteTarget(null);
    if (modelConnectionId === target.id) closeModels();
    if (form?.kind === "edit" && form.connectionId === target.id) closeForm();
  };

  const saveDefaults = async (values: { context?: number; output?: number }) => {
    if (!descriptor) return false;
    const action: Action = {
      type: "defaults",
      agent: descriptor.id,
      ...(values.context !== undefined ? { context: values.context } : {}),
      ...(values.output !== undefined ? { output: values.output } : {}),
    };
    return manager.run(action, { key: "defaults", errorPrefix: "保存默认限额失败" });
  };

  const body =
    view === "library" || !descriptor ? (
      snapshot ? (
        <ConnectionLibrary
          snapshot={snapshot}
          busy={busy}
          onNew={() => openCreate()}
          onEdit={(connection) => openEdit(connection)}
          onDelete={setDeleteTarget}
          onRefresh={refreshConnection}
          onTest={testConnection}
          onOpenAgent={selectAgent}
        />
      ) : null
    ) : (
      <AgentView
        snapshot={snapshot!}
        descriptor={descriptor}
        busy={busy}
        onManageModels={openModels}
        onEditConnection={(connection) => openEdit(connection)}
        onCreateConnection={() => openCreate(descriptor.id)}
        onAdaptConnection={(connection, mode, protocol) =>
          mode === "switch"
            ? openEdit(connection, descriptor.id, { protocol })
            : openCreate(descriptor.id, copyPreset(connection, protocol))
        }
        onDeleteConnection={setDeleteTarget}
        onRefreshConnection={refreshConnection}
        onTestConnection={testConnection}
        onOpenLibrary={() => changeView("library")}
        onSaveDefaults={saveDefaults}
      />
    );

  return (
    <View testID="ppm-screen" style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View
        style={{
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          backgroundColor: theme.colors.surface0,
          paddingHorizontal: compact ? 16 : 26,
          paddingTop: compact ? 12 : 16,
          paddingBottom: compact ? 10 : 12,
          gap: 10,
        }}
      >
        <View
          style={{
            flexDirection: compact ? "column" : "row",
            alignItems: compact ? "stretch" : "flex-start",
            gap: compact ? 8 : 12,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, justifyContent: "center" }}>
            <Text style={t.small} numberOfLines={compact ? 2 : 1}>
              {compact
                ? "按 Agent 管理连接、模型与限额；过期目录自动刷新。"
                : "先选 Agent，再为它复用连接、选择模型、校准上下文与输出限额。打开页面时自动刷新过期目录。"}
            </Text>
          </View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: compact ? "flex-start" : "flex-end",
              flexWrap: "wrap",
              gap: 6,
            }}
          >
            <Btn
              label={compact ? "刷新" : "刷新过期"}
              icon="RefreshCw"
              size={compact ? "sm" : "md"}
              onPress={() => void manager.refreshStale()}
              pending={autoRefreshing}
              disabled={!snapshot}
              testID="ppm-refresh-stale"
            />
            <Btn
              label={compact ? "新建" : "新建连接"}
              variant="primary"
              icon="Plus"
              size={compact ? "sm" : "md"}
              onPress={() => openCreate()}
              disabled={!snapshot}
              testID="ppm-new-connection"
            />
          </View>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <View style={{ flex: compact ? 1 : undefined, minWidth: compact ? 0 : 300, maxWidth: 380 }}>
            <Segmented
              value={view}
              onChange={changeView}
              options={[
                { value: "agents", label: "Agent 配置", count: snapshot?.agents.length },
                { value: "library", label: "连接库", count: snapshot?.connections.length },
              ]}
              testID="ppm-view-tabs"
            />
          </View>
        </View>

        {autoRefreshError && !autoErrorDismissed ? (
          <Notice
            tone="warning"
            title="自动刷新过期连接失败"
            action={
              <View style={{ flexDirection: "row", gap: 4 }}>
                <Btn
                  label="重试"
                  size="sm"
                  variant="ghost"
                  onPress={() => void manager.refreshStale()}
                  pending={autoRefreshing}
                />
                <IconBtn
                  icon="X"
                  label="忽略刷新错误"
                  onPress={() => setAutoErrorDismissed(true)}
                />
              </View>
            }
          >
            {autoRefreshError}
          </Notice>
        ) : null}

        {loadError && snapshot ? (
          <Notice
            tone="danger"
            title="同步最新数据失败"
            action={<Btn label="重试" size="sm" variant="ghost" onPress={() => void manager.reload()} />}
          >
            {loadError}
          </Notice>
        ) : null}
      </View>

      {loading && !snapshot ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10 }}>
          <Loading />
          <Text style={t.small}>正在读取供应商配置…</Text>
        </View>
      ) : !snapshot ? (
        <View style={{ flex: 1, padding: 20 }}>
          <Card style={{ padding: 0 }}>
            <EmptyState
              icon="CircleAlert"
              title="无法加载供应商配置"
              description={loadError ?? "服务端没有返回数据。"}
              action={
                <Btn
                  label="重新加载"
                  variant="primary"
                  icon="RefreshCw"
                  onPress={() => void manager.reload()}
                />
              }
            />
          </Card>
        </View>
      ) : (
        <View style={{ flex: 1, flexDirection: compact ? "column" : "row" }}>
          {snapshot.agents.length ? (
            <AgentRail
              snapshot={snapshot}
              selected={activeAgentId ?? snapshot.agents[0].id}
              onSelect={selectAgent}
            />
          ) : null}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{
              padding: compact ? 16 : 24,
              paddingBottom: 40,
            }}
            keyboardShouldPersistTaps="handled"
          >
            <View style={{ width: "100%", maxWidth: 1040, alignSelf: "center" }}>
              {snapshot.agents.length === 0 ? (
                <NoAgents snapshot={snapshot} />
              ) : view === "agents" && !descriptor ? (
                <NoAgents snapshot={snapshot} />
              ) : (
                body
              )}
            </View>
          </ScrollView>
        </View>
      )}

      {snapshot && descriptor && modelConnection ? (
        <ModelSheet
          open
          agent={descriptor}
          connection={modelConnection}
          binding={modelBinding}
          defaults={snapshot.defaults[descriptor.id]}
          busy={busy}
          onClose={closeModels}
          onEditConnection={(connection) => openEdit(connection)}
          run={manager.run}
          reload={manager.reload}
        />
      ) : null}

      <ConnectionForm
        open={formActive && Boolean(snapshot)}
        connection={formConnection}
        agents={snapshot?.agents ?? []}
        bindings={snapshot?.bindings ?? []}
        connections={snapshot?.connections ?? []}
        origin={formOrigin && formOrigin.protocols.length > 0 ? formOrigin : undefined}
        preset={form?.preset}
        onClose={closeForm}
        onSaved={(connectionId, protocol) => afterSave(form?.origin, connectionId, protocol)}
        onCopy={(connection) => openCreate(form?.origin, copyPreset(connection))}
        run={manager.run}
        busy={busy === "saveConnection"}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除连接？"
        description={
          deleteTarget
            ? `将永久删除 ${deleteTarget.name} 及其密钥。${
                snapshot
                  ? agentsUsing(snapshot, deleteTarget.id).length
                    ? `这会同时从 ${agentsUsing(snapshot, deleteTarget.id).length} 个 Agent 移除该连接和模型选择。`
                    : "当前没有 Agent 使用它。"
                  : ""
              }此操作无法撤销。`
            : ""
        }
        confirmLabel="删除连接"
        pending={busy === "deleteConnection"}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
        testID="ppm-delete-connection"
      />
    </View>
  );
}

function NoAgents({ snapshot }: { snapshot: Snapshot }) {
  return (
    <Card style={{ padding: 0 }}>
      <EmptyState
        icon="Bot"
        title="服务端没有返回 Agent"
        description={`当前快照包含 ${snapshot.connections.length} 个连接，但没有任何 Agent 描述。请刷新或检查插件服务端。`}
      />
    </Card>
  );
}
