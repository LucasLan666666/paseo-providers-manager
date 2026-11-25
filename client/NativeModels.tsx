import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, TextInput, View } from "react-native";
import { useState } from "react";
import { nativeCatalogRpc, type AgentId } from "../shared/contracts";

/**
 * Native providers (Muse, Hoplite, DSH) have no custom gateway connection.
 * The only token-free check available is their account/model catalog.
 */
export function NativeModels({
  agent,
  theme,
}: {
  agent: AgentId;
  theme: PluginTheme;
}) {
  return <Catalog key={agent} agent={agent} theme={theme} />;
}

function Catalog({ agent, theme }: { agent: AgentId; theme: PluginTheme }) {
  const read = useRpc(nativeCatalogRpc);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const color = theme.colors.foreground;
  async function testAll() {
    setBusy(true);
    setMessage("");
    try {
      const trimmedCwd = cwd.trim();
      const input = { agent, ...(trimmedCwd ? { cwd: trimmedCwd } : {}) };
      const list = await read(input);
      setModels(list);
      setMessage(
        list.length
          ? `已检查 ${list.length} 个原生模型，目录可正常列出；未发送推理消息。`
          : "此主机未返回可用模型。",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "原生目录不可用。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color, fontWeight: "600" }}>原生账号模型</Text>
      <TextInput
        accessibilityLabel="原生项目路径"
        placeholder="主机上的项目绝对路径（可选）"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={cwd}
        onChangeText={(v) => {
          setCwd(v);
          setModels([]);
          setMessage("");
        }}
        editable={!busy}
        style={{
          color,
          borderWidth: 1,
          borderColor: theme.colors.border,
          padding: 8,
        }}
      />
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => void testAll()}
        style={{ padding: 8, alignSelf: "flex-start", opacity: busy ? 0.6 : 1 }}
      >
        <Text style={{ color: theme.colors.accent }}>
          {busy ? "测试中…" : "测试全部模型"}
        </Text>
      </Pressable>
      {message ? <Text style={{ color }}>{message}</Text> : null}
      {models.map((m) => (
        <Text key={m.id} style={{ color }}>
          {m.label} · {m.id}
        </Text>
      ))}
    </View>
  );
}
