import { useEffect, useMemo, useState } from "react";
import { Icon } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { protocols, type Action, type Connection, type Protocol } from "../shared/contracts";
import type { AgentDescriptor } from "./derive";
import { protocolDescription, protocolLabel } from "./format";
import {
  Badge,
  Btn,
  Chip,
  Field,
  Notice,
  Sheet,
  TextField,
  useLayout,
} from "./ui";

type FormErrors = {
  name?: string;
  url?: string;
};

export function ConnectionForm({
  open,
  connection,
  agent,
  onClose,
  onSaved,
  run,
  busy,
}: {
  open: boolean;
  connection: Connection | null;
  agent?: AgentDescriptor;
  onClose: () => void;
  onSaved?: () => void;
  run: (action: Action, options?: { key?: string; toast?: boolean }) => Promise<boolean>;
  busy: boolean;
}) {
  const { theme, compact } = useLayout();
  const editing = Boolean(connection);
  const [name, setName] = useState(connection?.name ?? "");
  const [url, setUrl] = useState(connection?.url ?? "");
  const [protocol, setProtocol] = useState<Protocol>(
    connection?.protocol ?? agent?.protocols[0] ?? "chat",
  );
  const [catalogProvider, setCatalogProvider] = useState(connection?.catalogProvider ?? "");
  const [key, setKey] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(connection?.name ?? "");
    setUrl(connection?.url ?? "");
    setProtocol(connection?.protocol ?? agent?.protocols[0] ?? "chat");
    setCatalogProvider(connection?.catalogProvider ?? "");
    setKey("");
    setErrors({});
    setSaving(false);
  }, [open, connection?.id, agent?.id]);

  const compatible = useMemo(
    () => (agent ? agent.protocols.includes(protocol) : true),
    [agent, protocol],
  );

  const handleSave = async () => {
    const nextErrors: FormErrors = {};
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName) nextErrors.name = "请输入连接名称";
    if (!trimmedUrl) nextErrors.url = "请输入网关地址";
    else if (!/^https?:\/\/\S+$/i.test(trimmedUrl)) {
      nextErrors.url = "地址必须以 http:// 或 https:// 开头";
    }
    if (Object.keys(nextErrors).length > 0) {
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
    };
    setSaving(true);
    const saved = await run(action, { key: "saveConnection" });
    setSaving(false);
    if (saved) {
      onClose();
      onSaved?.();
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
      title={editing ? "编辑连接" : "新建连接"}
      icon={<Icon name="Server" size={18} color={theme.colors.accent} />}
      testID="ppm-connection-form"
      footer={
        <>
          <Btn label="取消" onPress={onClose} disabled={saving} />
          <Btn
            label={editing ? "保存更改" : "创建连接"}
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
        <TextField
          label="名称"
          required
          value={name}
          onChangeText={(value) => {
            setName(value);
            if (errors.name) setErrors((current) => ({ ...current, name: undefined }));
          }}
          placeholder="例如 OpenRouter 主账号"
          error={errors.name}
          editable={!saving}
          testID="ppm-connection-name"
          autoFocus={!editing}
        />
        <TextField
          label="目录供应商"
          value={catalogProvider}
          onChangeText={setCatalogProvider}
          placeholder="例如 openrouter"
          hint="用于目录容量与模型元数据；可留空"
          editable={!saving}
          testID="ppm-connection-catalog"
        />
      </View>

      <TextField
        label="网关地址"
        required
        value={url}
        onChangeText={(value) => {
          setUrl(value);
          if (errors.url) setErrors((current) => ({ ...current, url: undefined }));
        }}
        placeholder="https://gateway.example.com/v1"
        error={errors.url}
        keyboardType="url"
        editable={!saving}
        testID="ppm-connection-url"
      />

      <Field label="协议" hint={protocolDescription(protocol)} required>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
          {protocols.map((option) => (
            <Chip
              key={option}
              label={protocolLabel(option)}
              selected={protocol === option}
              onPress={() => setProtocol(option)}
              disabled={saving}
              testID={`ppm-protocol-${option}`}
            />
          ))}
        </View>
      </Field>

      {!compatible && agent ? (
        <Notice tone="warning" title="协议与当前 Agent 不兼容">
          该连接使用 {protocolLabel(protocol)}，而 {agent.label} 支持{" "}
          {agent.protocols.map(protocolLabel).join(" / ")}。保存后它只能用于支持该协议的 Agent。
        </Notice>
      ) : null}

      <TextField
        label={editing ? "替换 API 密钥" : "API 密钥"}
        value={key}
        onChangeText={setKey}
        placeholder={editing && connection?.hasKey ? "留空以保留现有密钥" : "可留空，稍后再配置"}
        hint={
          editing
            ? connection?.hasKey
              ? "已保存密钥。留空保持不变；输入新值才会替换。"
              : "当前没有保存密钥。留空则仍不保存密钥。"
            : "密钥仅保存在本机 daemon 侧的插件数据中，生成 Agent 配置时会提供给 CLI 访问网关。"
        }
        secure
        allowReveal
        editable={!saving}
        testID="ppm-connection-key"
        trailing={connection?.hasKey ? <Badge tone="success" label="已保存" /> : undefined}
      />

    </Sheet>
  );
}
