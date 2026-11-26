import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, TextInput, View } from "react-native";
import { useState } from "react";
import { nativeCatalogRpc, type AgentId } from "../shared/contracts";
import { useTr } from "./ui";

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
  const { tr, lang } = useTr();
  async function testAll() {
    setBusy(true);
    setMessage("");
    try {
      const trimmedCwd = cwd.trim();
      const input = { agent, lang, ...(trimmedCwd ? { cwd: trimmedCwd } : {}) };
      const list = await read(input);
      setModels(list);
      setMessage(
        list.length
          ? tr(
              `已检查 ${list.length} 个原生模型，目录可正常列出；未发送推理消息。`,
              `Checked ${list.length} native models; the list loads. No inference request was sent.`,
            )
          : tr("此主机未返回可用模型。", "This host returned no models."),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : tr("原生目录不可用。", "The native model list is unavailable."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color, fontWeight: "600" }}>{tr("原生账号模型", "Native account models")}</Text>
      <TextInput
        accessibilityLabel={tr("原生项目路径", "Native project path")}
        placeholder={tr("主机上的项目绝对路径（可选）", "Absolute project path on the host (optional)")}
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
          {busy ? tr("测试中…", "Testing…") : tr("测试全部模型", "Test all models")}
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
