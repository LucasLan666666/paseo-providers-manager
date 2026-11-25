import type { AgentId, Limits } from "../shared/contracts";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { formatTokens, parseTokens, rawTokens } from "./format";
import { Badge, Btn, Card, SectionHead, TextField, useLayout } from "./ui";

export function DefaultsCard({
  agent,
  limits,
  busy,
  onSave,
}: {
  agent: AgentId;
  limits: Limits | undefined;
  busy: boolean;
  onSave: (values: { context?: number; output?: number }) => Promise<boolean>;
}) {
  const { theme, compact } = useLayout();
  const [contextText, setContextText] = useState(rawTokens(limits?.context));
  const [outputText, setOutputText] = useState(rawTokens(limits?.output));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<{ context?: string; output?: string }>({});

  useEffect(() => {
    setContextText(rawTokens(limits?.context));
    setOutputText(rawTokens(limits?.output));
    setDirty(false);
    setErrors({});
  }, [agent, limits?.context, limits?.output]);

  const handleSave = async () => {
    const context = parseTokens(contextText);
    const output = parseTokens(outputText);
    if (context.error || output.error) {
      setErrors({ context: context.error, output: output.error });
      return;
    }
    setErrors({});
    const saved = await onSave({ context: context.value, output: output.value });
    if (saved) setDirty(false);
  };

  return (
    <Card>
      <SectionHead
        icon="SlidersHorizontal"
        title="默认限额"
        subtitle="模型没有提供、也没有手动覆盖时，作为该 Agent 的兜底上限。"
        trailing={
          limits?.context || limits?.output ? (
            <Badge
              tone="accent"
              label={[
                limits.context ? `上下文 ${formatTokens(limits.context)}` : "",
                limits.output ? `输出 ${formatTokens(limits.output)}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          ) : (
            <Badge label="未设置" />
          )
        }
      />
      <View style={{ flexDirection: compact ? "column" : "row", gap: 10, alignItems: "flex-start" }}>
        <TextField
          label="上下文上限"
          value={contextText}
          onChangeText={(value) => {
            setContextText(value);
            setDirty(true);
            if (errors.context) setErrors((current) => ({ ...current, context: undefined }));
          }}
          placeholder="例如 200K"
          hint="tokens，留空表示不设置"
          error={errors.context}
          editable={!busy}
          testID="ppm-defaults-context"
        />
        <TextField
          label="输出上限"
          value={outputText}
          onChangeText={(value) => {
            setOutputText(value);
            setDirty(true);
            if (errors.output) setErrors((current) => ({ ...current, output: undefined }));
          }}
          placeholder="例如 64K"
          hint="tokens，留空表示不设置"
          error={errors.output}
          editable={!busy}
          testID="ppm-defaults-output"
        />
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, lineHeight: 17, flex: 1, minWidth: 180 }}>
          默认值只在模型没有给出容量、且未手动覆盖时生效。模型自带的网关 / 目录数据优先。
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Btn
            label="重置"
            onPress={() => {
              setContextText(rawTokens(limits?.context));
              setOutputText(rawTokens(limits?.output));
              setErrors({});
              setDirty(false);
            }}
            disabled={!dirty || busy}
          />
          <Btn
            label="保存默认值"
            variant="primary"
            icon="Check"
            onPress={() => void handleSave()}
            disabled={!dirty || busy}
            pending={busy}
            testID="ppm-defaults-save"
          />
        </View>
      </View>
    </Card>
  );
}
