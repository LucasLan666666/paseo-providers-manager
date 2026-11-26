import { useEffect, useState } from "react";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import {
  protocols,
  type Action,
  type AgentId,
  type Binding,
  type Connection,
  type Protocol,
} from "../shared/contracts";
import type { AgentDescriptor } from "./derive";
import { count, protocolDescription, protocolFullLabel } from "./format";
import type { FormPreset } from "./screenState";
import type { RunOptions } from "./useManager";
import {
  Badge,
  Btn,
  Chip,
  Field,
  Notice,
  Sheet,
  TextField,
  useLayout,
  useTokens,
  useTr,
} from "./ui";

type FormErrors = {
  name?: string;
  url?: string;
  protocol?: string;
  key?: string;
};

function originOf(raw: string): string | undefined {
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return undefined;
  }
}

export function ConnectionForm({
  open,
  connection,
  agents,
  bindings,
  connections,
  origin,
  preset,
  onClose,
  onSaved,
  onCopy,
  run,
  busy,
}: {
  open: boolean;
  connection: Connection | null;
  agents: readonly AgentDescriptor[];
  bindings: readonly Binding[];
  connections: readonly Connection[];
  /** The agent whose page opened the form; undefined from the top bar or library. */
  origin?: AgentDescriptor;
  preset?: FormPreset;
  onClose: () => void;
  onSaved?: (connectionId: string | undefined, protocol: Protocol) => void;
  onCopy?: (connection: Connection) => void;
  run: (action: Action, options?: RunOptions) => Promise<boolean>;
  busy: boolean;
}) {
  const { theme, compact } = useLayout();
  // Name and catalog provider share a row on wide screens; equal halves there.
  const column = compact ? undefined : { flex: 1, minWidth: 0 };
  const { tr, lang } = useTr();
  const t = useTokens(theme, compact);
  const editing = Boolean(connection);
  const copySource = !editing && preset?.copyFrom
    ? connections.find((item) => item.id === preset.copyFrom)
    : undefined;

  // A remembered "switch protocol" preset no longer applies once an agent has
  // enabled models on the connection (the protocol is locked then).
  const lockedNow = connection
    ? bindings.some((binding) => binding.connection === connection.id && binding.selected.length > 0)
    : false;
  const initialProtocol = (): Protocol | null =>
    (lockedNow ? undefined : preset?.protocol) ??
    connection?.protocol ??
    // Only preselect when the opening agent leaves no choice. The top bar used to
    // default to "chat", which is how Responses-only gateways ended up as Chat.
    (origin && origin.protocols.length === 1 ? origin.protocols[0] : null);

  const [name, setName] = useState(preset?.name ?? connection?.name ?? "");
  const [url, setUrl] = useState(preset?.url ?? connection?.url ?? "");
  const [protocol, setProtocol] = useState<Protocol | null>(initialProtocol);
  const [catalogProvider, setCatalogProvider] = useState(
    preset?.catalogProvider ?? connection?.catalogProvider ?? "",
  );
  const [key, setKey] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const presetKey = JSON.stringify(preset ?? null);

  useEffect(() => {
    if (!open) return;
    setName(preset?.name ?? connection?.name ?? "");
    setUrl(preset?.url ?? connection?.url ?? "");
    setProtocol(initialProtocol());
    setCatalogProvider(preset?.catalogProvider ?? connection?.catalogProvider ?? "");
    setKey("");
    setErrors({});
    setSaving(false);
    // initialProtocol only reads the values listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connection?.id, origin?.id, presetKey]);

  const agentLabel = (id: AgentId) => agents.find((agent) => agent.id === id)?.label ?? id;
  const gatewayAgents = agents.filter((agent) => agent.protocols.length > 0);
  const supporters = (option: Protocol) =>
    gatewayAgents.filter((agent) => agent.protocols.includes(option));

  const usage = connection ? bindings.filter((binding) => binding.connection === connection.id) : [];
  const inUse = usage.filter((binding) => binding.selected.length > 0);
  // Mirrors the server: a protocol change is refused while any agent has models enabled.
  const locked = editing && inUse.length > 0;
  const changed = editing && protocol !== null && protocol !== connection?.protocol;
  const dropped = changed
    ? usage.filter(
        (binding) => !agents.find((agent) => agent.id === binding.agent)?.protocols.includes(protocol!),
      )
    : [];
  const originMismatch = origin && protocol !== null && !origin.protocols.includes(protocol);
  const copyOriginChanged =
    copySource !== undefined && originOf(url) !== undefined && originOf(url) !== originOf(copySource.url);

  const handleSave = async () => {
    const nextErrors: FormErrors = {};
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName) nextErrors.name = tr("请输入连接名称", "Enter a connection name");
    if (!trimmedUrl) nextErrors.url = tr("请输入网关地址", "Enter the gateway URL");
    else if (!/^https?:\/\/\S+$/i.test(trimmedUrl)) {
      nextErrors.url = tr("地址必须以 http:// 或 https:// 开头", "The URL must start with http:// or https://");
    }
    if (!protocol) nextErrors.protocol = tr("请选择网关提供的协议", "Choose the protocol the gateway serves");
    if (copyOriginChanged && !key.trim())
      nextErrors.key = tr(
        `域名或端口与「${copySource?.name}」不同，请输入这个地址的 API 密钥`,
        `The host or port differs from “${copySource?.name}”; enter the API key for this address`,
      );
    if (Object.keys(nextErrors).length > 0 || !protocol) {
      setErrors(nextErrors);
      return;
    }

    const action: Action = {
      type: "saveConnection",
      ...(connection ? { id: connection.id } : {}),
      name: trimmedName,
      url: trimmedUrl,
      protocol,
      catalogProvider: catalogProvider.trim(),
      ...(key.trim() ? { key: key.trim() } : {}),
      ...(copySource ? { copyKeyFrom: copySource.id } : {}),
    };
    setSaving(true);
    let savedId: string | undefined;
    const saved = await run(action, {
      key: "saveConnection",
      onSuccess: (result) => {
        savedId = result.connection;
      },
    });
    setSaving(false);
    if (saved) {
      onClose();
      onSaved?.(savedId, protocol);
    }
  };

  const keyHint = copySource
    ? tr(
        `留空则沿用「${copySource.name}」的密钥（仅限同一域名和端口）。`,
        `Leave empty to reuse the key of “${copySource.name}” (same host and port only).`,
      )
    : editing
      ? connection?.hasKey
        ? tr("已保存密钥。留空保持不变；输入新值才会替换。", "A key is saved. Leave empty to keep it; enter a new one to replace it.")
        : tr("当前没有保存密钥。留空则仍不保存密钥。", "No key is saved. Leaving this empty keeps it that way.")
      : tr(
          "密钥仅保存在本机 daemon 侧的插件数据中，生成 Agent 配置时会提供给 CLI 访问网关。",
          "The key is stored only in this plugin's data on the daemon host and handed to the CLI when its configuration is generated.",
        );
  const keyPlaceholder = copySource
    ? tr("留空沿用原连接的密钥", "Empty: reuse the original key")
    : editing && connection?.hasKey
      ? tr("留空以保留现有密钥", "Empty: keep the saved key")
      : tr("可留空，稍后再配置", "Optional, can be added later");

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
      title={editing ? tr("编辑连接", "Edit connection") : copySource ? tr("复制连接", "Copy connection") : tr("新建连接", "New connection")}
      icon={<Icon name="Server" size={18} color={theme.colors.accent} />}
      testID="ppm-connection-form"
      footer={
        <>
          <Btn label={tr("取消", "Cancel")} onPress={onClose} disabled={saving} />
          <Btn
            label={editing ? tr("保存更改", "Save changes") : tr("创建连接", "Create connection")}
            variant="primary"
            icon="Check"
            onPress={() => void handleSave()}
            pending={saving || busy}
            testID="ppm-connection-save"
          />
        </>
      }
    >
      <View style={{ flexDirection: compact ? "column" : "row", gap: 10 }}>
        <View style={column}>
          <TextField
            label={tr("名称", "Name")}
            required
            value={name}
            onChangeText={(value) => {
              setName(value);
              if (errors.name) setErrors((current) => ({ ...current, name: undefined }));
            }}
            placeholder={tr("例如 OpenRouter 主账号", "e.g. OpenRouter main account")}
            error={errors.name}
            editable={!saving}
            testID="ppm-connection-name"
            autoFocus={!editing}
          />
        </View>
        <View style={column}>
          <TextField
            label={tr("目录供应商", "Catalog provider")}
            value={catalogProvider}
            onChangeText={setCatalogProvider}
            placeholder={tr("例如 openrouter", "e.g. openrouter")}
            hint={tr("用于目录容量与模型元数据；可留空", "Used for model limits and metadata; optional")}
            editable={!saving}
            testID="ppm-connection-catalog"
          />
        </View>
      </View>

      <TextField
        label={tr("网关地址", "Gateway URL")}
        required
        value={url}
        onChangeText={(value) => {
          setUrl(value);
          if (errors.url || errors.key)
            setErrors((current) => ({ ...current, url: undefined, key: undefined }));
        }}
        placeholder="https://gateway.example.com/v1"
        error={errors.url}
        keyboardType="url"
        editable={!saving}
        testID="ppm-connection-url"
      />

      <Field
        label={tr("协议", "Protocol")}
        hint={protocol ? protocolDescription(protocol, lang) : tr("按网关文档中的请求地址选择", "Choose by the request path in the gateway's docs")}
        required
      >
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
            {protocols.map((option) => (
              <Chip
                key={option}
                label={protocolFullLabel(option)}
                selected={protocol === option}
                onPress={() => {
                  setProtocol(option);
                  if (errors.protocol) setErrors((current) => ({ ...current, protocol: undefined }));
                }}
                disabled={saving || (locked && option !== connection?.protocol)}
                testID={`ppm-protocol-${option}`}
              />
            ))}
          </View>
          {protocol ? (
            <Text style={t.tiny}>
              {tr("可用于：", "Works with: ")}
              {supporters(protocol).map((agent) => agent.label).join(" · ") || tr("无", "none")}
            </Text>
          ) : (
            <Text style={t.tiny}>
              {tr(
                "…/chat/completions → OpenAI Chat Completions；…/responses → OpenAI Responses；…/v1/messages → Anthropic Messages；…:generateContent → Google Gemini。",
                "…/chat/completions → OpenAI Chat Completions; …/responses → OpenAI Responses; …/v1/messages → Anthropic Messages; …:generateContent → Google Gemini.",
              )}
            </Text>
          )}
          {errors.protocol ? (
            <Text style={[t.tiny, { color: theme.colors.statusDanger }]}>{errors.protocol}</Text>
          ) : null}
        </View>
      </Field>

      {originMismatch && origin && protocol ? (
        <Notice
          tone="warning"
          title={tr(`${origin.label} 不能使用 ${protocolFullLabel(protocol)}`, `${origin.label} cannot use ${protocolFullLabel(protocol)}`)}
        >
          {tr(
            `${origin.label} 需要 ${origin.protocols.map(protocolFullLabel).join(" / ")}。按当前协议保存后，这个连接不会出现在 ${origin.label} 的连接列表中。`,
            `${origin.label} needs ${origin.protocols.map(protocolFullLabel).join(" / ")}. Saved with this protocol, the connection won't appear in ${origin.label}'s list.`,
          )}
        </Notice>
      ) : null}

      {locked && connection ? (
        <Notice
          tone="accent"
          title={tr("协议已锁定", "Protocol locked")}
          action={
            onCopy ? (
              <Btn label={tr("复制为新连接", "Copy as new")} size="sm" variant="ghost" onPress={() => onCopy(connection)} />
            ) : undefined
          }
        >
          {tr(
            `${inUse.map((binding) => `${agentLabel(binding.agent)}（${binding.selected.length} 个模型）`).join("、")} 正在使用这个连接。要更换协议，请先在这些 Agent 中停用它的模型；如果网关同时提供其他协议，可以复制一个新连接。`,
            `${inUse.map((binding) => `${agentLabel(binding.agent)} (${count(binding.selected.length, "model", "models")})`).join(", ")} use this connection. To change the protocol, turn off its models in those agents first; if the gateway also serves another protocol, copy the connection instead.`,
          )}
        </Notice>
      ) : null}

      {dropped.length && protocol ? (
        <Notice tone="warning" title={tr("保存后这些 Agent 将移除此连接", "Saving removes this connection from these agents")}>
          {tr(
            `${dropped.map((binding) => agentLabel(binding.agent)).join("、")} 不支持 ${protocolFullLabel(protocol)}。它们还没有启用这个连接的模型，保存后会从各自的连接列表中移除。`,
            `${dropped.map((binding) => agentLabel(binding.agent)).join(", ")} ${dropped.length === 1 ? "does" : "do"} not support ${protocolFullLabel(protocol)}. They have no models enabled on it, so saving removes it from their lists.`,
          )}
        </Notice>
      ) : null}

      <TextField
        label={editing ? tr("替换 API 密钥", "Replace API key") : tr("API 密钥", "API key")}
        value={key}
        onChangeText={(value) => {
          setKey(value);
          if (errors.key) setErrors((current) => ({ ...current, key: undefined }));
        }}
        placeholder={keyPlaceholder}
        hint={keyHint}
        error={errors.key}
        secure
        allowReveal
        editable={!saving}
        testID="ppm-connection-key"
        trailing={connection?.hasKey ? <Badge tone="success" label={tr("已保存", "Saved")} /> : undefined}
      />
    </Sheet>
  );
}
