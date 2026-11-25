import type { PluginTheme } from "@getpaseo/plugin";
import {
  copyText,
  Icon,
  Modal,
  TextInput as HostTextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import * as React from "react";
import { type ReactNode, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  type StyleProp,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, monospace",
});

export function withAlpha(color: string, amount: number): string {
  const alpha = Math.round(Math.max(0, Math.min(1, amount)) * 255)
    .toString(16)
    .padStart(2, "0");
  if (/^#[0-9a-f]{6}$/i.test(color)) return `${color}${alpha}`;
  if (/^#[0-9a-f]{8}$/i.test(color)) return `${color.slice(0, 7)}${alpha}`;
  return color;
}

export function toneColor(theme: PluginTheme, tone: BadgeTone): string {
  switch (tone) {
    case "accent":
      return theme.colors.accent;
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

export interface Tokens {
  theme: PluginTheme;
  colors: PluginTheme["colors"];
  compact: boolean;
  gap: number;
  cardPad: number;
  radius: number;
  radiusSmall: number;
  title: TextStyle;
  screenTitle: TextStyle;
  h2: TextStyle;
  h3: TextStyle;
  body: TextStyle;
  bodyStrong: TextStyle;
  muted: TextStyle;
  small: TextStyle;
  tiny: TextStyle;
  mono: TextStyle;
  card: ViewStyle;
  inset: ViewStyle;
  row: ViewStyle;
  rowBetween: ViewStyle;
  wrap: ViewStyle;
  divider: ViewStyle;
}

export function useTokens(theme: PluginTheme, compact: boolean): Tokens {
  return useMemo<Tokens>(() => {
    const colors = theme.colors;
    return {
      theme,
      colors,
      compact,
      gap: compact ? 12 : 16,
      cardPad: compact ? 14 : 18,
      radius: 14,
      radiusSmall: 9,
      title: { color: colors.foreground, fontSize: compact ? 20 : 24, fontWeight: "700" },
      screenTitle: { color: colors.foreground, fontSize: compact ? 19 : 23, fontWeight: "700" },
      h2: { color: colors.foreground, fontSize: compact ? 16 : 17, fontWeight: "600" },
      h3: { color: colors.foreground, fontSize: 14, fontWeight: "600" },
      body: { color: colors.foreground, fontSize: 14, lineHeight: 20 },
      bodyStrong: { color: colors.foreground, fontSize: 14, fontWeight: "600", lineHeight: 20 },
      muted: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
      small: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      tiny: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 15 },
      mono: {
        color: colors.foregroundMuted,
        fontSize: 11,
        lineHeight: 16,
        fontFamily: MONO_FONT,
      },
      card: {
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 14,
      },
      inset: {
        backgroundColor: colors.surface2,
        borderRadius: 10,
      },
      row: { flexDirection: "row", alignItems: "center", gap: 8 },
      rowBetween: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      },
      wrap: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
      divider: { height: 1, backgroundColor: colors.border },
    };
  }, [theme, compact]);
}

export function Badge({
  label,
  tone = "neutral",
  icon,
  testID,
}: {
  label: string;
  tone?: BadgeTone;
  icon?: string;
  testID?: string;
}) {
  const { theme } = useLayout();
  const color = toneColor(theme, tone);
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        borderWidth: 1,
        borderColor: withAlpha(color, 0.28),
        backgroundColor: withAlpha(color, 0.1),
        borderRadius: 999,
        paddingHorizontal: 7,
        paddingVertical: 2,
      }}
    >
      {icon ? <Icon name={icon} size={11} color={color} /> : null}
      <Text style={{ color, fontSize: 11, fontWeight: "600", lineHeight: 15 }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

interface LayoutValue {
  theme: PluginTheme;
  compact: boolean;
}

const LayoutContext = React.createContext<LayoutValue | null>(null);

// A safety net for host modal roots that mount their children in a fresh React
// root. Modal content is explicitly wrapped below, but a stale portal from an
// older root should still render with the last known theme instead of crashing
// the whole app.
let fallbackLayout: LayoutValue | null = null;

export function UiProvider({
  theme,
  compact,
  children,
}: {
  theme: PluginTheme;
  compact: boolean;
  children: ReactNode;
}) {
  fallbackLayout = { theme, compact };
  return (
    <LayoutContext.Provider value={{ theme, compact }}>{children}</LayoutContext.Provider>
  );
}

export function useLayout(): LayoutValue {
  const value = React.useContext(LayoutContext);
  if (value) return value;
  if (fallbackLayout) return fallbackLayout;
  throw new Error("Provider UI components must be rendered inside <UiProvider>.");
}

export function Card({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const t = useTokensFromLayout();
  return (
    <View testID={testID} style={[t.card, { padding: t.cardPad, gap: t.gap }, style]}>
      {children}
    </View>
  );
}

function useTokensFromLayout(): Tokens {
  const { theme, compact } = useLayout();
  return useTokens(theme, compact);
}

export function SectionHead({
  title,
  subtitle,
  trailing,
  icon,
}: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  icon?: string;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  return (
    <View style={[t.rowBetween, { alignItems: "flex-end" }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={[t.row, { gap: 6 }]}>
          {icon ? <Icon name={icon} size={15} color={theme.colors.foregroundMuted} /> : null}
          <Text style={t.h2}>{title}</Text>
        </View>
        {subtitle ? <Text style={t.small}>{subtitle}</Text> : null}
      </View>
      {trailing ? <View style={t.row}>{trailing}</View> : null}
    </View>
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Btn({
  label,
  onPress,
  icon,
  variant = "secondary",
  size = "md",
  disabled = false,
  pending = false,
  fullWidth = false,
  testID,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  icon?: string;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  disabled?: boolean;
  pending?: boolean;
  fullWidth?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  const { colors } = theme;
  const blocked = disabled || pending;
  const height = size === "sm" ? 30 : compact ? 38 : 36;
  const paddingHorizontal = size === "sm" ? 9 : 13;
  const palette = buttonPalette(theme, variant);
  const labelText = pending ? "处理中…" : label;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: blocked, busy: pending }}
      testID={testID}
      disabled={blocked}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        {
          minHeight: height,
          borderRadius: t.radiusSmall,
          paddingHorizontal,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          borderWidth: 1,
          borderColor: palette.border,
          backgroundColor: pressed && !blocked ? palette.pressed : palette.background,
          opacity: blocked && !pending ? 0.45 : pressed && !blocked ? 0.82 : 1,
          alignSelf: fullWidth ? "stretch" : "auto",
        },
      ]}
    >
      {icon ? <Icon name={icon} size={size === "sm" ? 13 : 15} color={palette.text} /> : null}
      <Text
        style={{
          color: palette.text,
          fontSize: size === "sm" ? 12 : 13,
          fontWeight: "600",
          lineHeight: 18,
        }}
        numberOfLines={1}
      >
        {labelText}
      </Text>
    </Pressable>
  );
}

function buttonPalette(theme: PluginTheme, variant: ButtonVariant) {
  const { colors } = theme;
  switch (variant) {
    case "primary":
      return {
        background: colors.accent,
        pressed: colors.accent,
        border: colors.accent,
        text: colors.accentForeground,
      };
    case "ghost":
      return {
        background: "transparent",
        pressed: withAlpha(colors.foreground, 0.06),
        border: "transparent",
        text: colors.foregroundMuted,
      };
    case "danger":
      return {
        background: withAlpha(colors.statusDanger, 0.12),
        pressed: withAlpha(colors.statusDanger, 0.2),
        border: withAlpha(colors.statusDanger, 0.35),
        text: colors.statusDanger,
      };
    default:
      return {
        background: colors.surface2,
        pressed: colors.surface2,
        border: colors.border,
        text: colors.foreground,
      };
  }
}

export function IconBtn({
  icon,
  label,
  onPress,
  disabled = false,
  tone = "muted",
  size = 30,
  testID,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "muted" | "danger" | "foreground";
  size?: number;
  testID?: string;
}) {
  const { theme } = useLayout();
  const color =
    tone === "danger"
      ? theme.colors.statusDanger
      : tone === "foreground"
        ? theme.colors.foreground
        : theme.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : 1,
        backgroundColor: pressed && !disabled ? withAlpha(theme.colors.foreground, 0.08) : "transparent",
      })}
    >
      <Icon name={icon} size={16} color={color} />
    </Pressable>
  );
}

export function Chip({
  label,
  selected = false,
  onPress,
  icon,
  count,
  testID,
  disabled,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: string;
  count?: number;
  testID?: string;
  disabled?: boolean;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  const color = selected ? theme.colors.accent : theme.colors.foregroundMuted;
  const content = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? withAlpha(theme.colors.accent, 0.4) : theme.colors.border,
        backgroundColor: selected ? withAlpha(theme.colors.accent, 0.12) : theme.colors.surface1,
        paddingHorizontal: compact ? 10 : 11,
        paddingVertical: 6,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {icon ? <Icon name={icon} size={13} color={color} /> : null}
      <Text style={{ color, fontSize: 12, fontWeight: selected ? "600" : "500" }}>{label}</Text>
      {count !== undefined ? (
        <Text
          style={{
            color: selected ? theme.colors.accent : theme.colors.foregroundMuted,
            fontSize: 11,
            fontVariant: ["tabular-nums"],
            opacity: 0.8,
          }}
        >
          {count}
        </Text>
      ) : null}
    </View>
  );
  if (!onPress) return <View testID={testID}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
    >
      {content}
    </Pressable>
  );
}

export function Segmented<Value extends string>({
  value,
  options,
  onChange,
  testID,
  compact: forceCompact,
}: {
  value: Value;
  options: readonly { value: Value; label: string; count?: number }[];
  onChange: (value: Value) => void;
  testID?: string;
  compact?: boolean;
}) {
  const layout = useLayout();
  const compact = forceCompact ?? layout.compact;
  const t = useTokens(layout.theme, compact);
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: layout.theme.colors.surface2,
        borderRadius: 10,
        padding: 3,
        gap: 2,
      }}
      testID={testID}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={option.label}
            testID={testID ? `${testID}-${option.value}` : undefined}
            onPress={() => onChange(option.value)}
            style={{
              flex: 1,
              minHeight: 30,
              borderRadius: 7,
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "row",
              gap: 5,
              backgroundColor: active ? layout.theme.colors.surface0 : "transparent",
              borderWidth: 1,
              borderColor: active ? layout.theme.colors.border : "transparent",
            }}
          >
            <Text
              style={{
                color: active ? layout.theme.colors.foreground : layout.theme.colors.foregroundMuted,
                fontSize: 12,
                fontWeight: active ? "600" : "500",
              }}
            >
              {option.label}
            </Text>
            {option.count !== undefined ? (
              <Text style={[t.tiny, { fontVariant: ["tabular-nums"] }]}>{option.count}</Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  return <View style={[t.divider, style]} />;
}

export function Notice({
  tone,
  title,
  children,
  action,
  testID,
}: {
  tone: Exclude<BadgeTone, "neutral" | "accent"> | "accent";
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  testID?: string;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  const color = toneColor(theme, tone);
  const icon =
    tone === "danger" ? "CircleAlert" : tone === "warning" ? "AlertTriangle" : tone === "success" ? "CircleCheck" : "Info";
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        gap: 9,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: withAlpha(color, 0.25),
        backgroundColor: withAlpha(color, 0.08),
        paddingHorizontal: 11,
        paddingVertical: 9,
        alignItems: "flex-start",
      }}
    >
      <Icon name={icon} size={15} color={color} />
      <View style={{ flex: 1, gap: 3 }}>
        {title ? (
          <Text style={{ color, fontSize: 12.5, fontWeight: "600", lineHeight: 18 }}>{title}</Text>
        ) : null}
        {children ? (
          typeof children === "string" ||
          typeof children === "number" ||
          Array.isArray(children) ? (
            <Text style={{ color: t.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
              {children}
            </Text>
          ) : (
            children
          )
        ) : null}
      </View>
      {action}
    </View>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  required,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  required?: boolean;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  return (
    <View style={{ gap: 5, flex: 1, minWidth: 0 }}>
      {label ? (
        <Text style={[t.small, { color: theme.colors.foreground, fontWeight: "600" }]}>
          {label}
          {required ? <Text style={{ color: theme.colors.statusDanger }}> *</Text> : null}
        </Text>
      ) : null}
      {children}
      {error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 11.5, lineHeight: 16 }}>{error}</Text>
      ) : hint ? (
        <Text style={t.tiny}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function TextField({
  label,
  hint,
  error,
  value,
  onChangeText,
  placeholder,
  secure = false,
  allowReveal = false,
  autoCapitalize = "none",
  keyboardType,
  multiline = false,
  editable = true,
  testID,
  onSubmitEditing,
  autoFocus,
  required,
  trailing,
  monospace = false,
}: {
  label?: string;
  hint?: string;
  error?: string | null;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  secure?: boolean;
  allowReveal?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  keyboardType?: "default" | "numeric" | "url" | "email-address";
  multiline?: boolean;
  editable?: boolean;
  testID?: string;
  onSubmitEditing?: () => void;
  autoFocus?: boolean;
  required?: boolean;
  trailing?: ReactNode;
  monospace?: boolean;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const input = (
    <View
      style={{
        flexDirection: "row",
        alignItems: multiline ? "flex-start" : "center",
        gap: 6,
        borderWidth: 1,
        borderColor: error
          ? theme.colors.statusDanger
          : focused
            ? theme.colors.accent
            : theme.colors.border,
        backgroundColor: theme.colors.surface0,
        borderRadius: 9,
        paddingHorizontal: 10,
        minHeight: compact ? 38 : 36,
        opacity: editable ? 1 : 0.6,
      }}
    >
      <HostTextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        secureTextEntry={secure && !revealed}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType={keyboardType}
        multiline={multiline}
        editable={editable}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={onSubmitEditing}
        autoFocus={autoFocus}
        style={{
          flex: 1,
          minWidth: 0,
          color: theme.colors.foreground,
          fontSize: 13,
          lineHeight: 19,
          paddingVertical: 8,
          ...(multiline ? { minHeight: 74, textAlignVertical: "top" as const } : {}),
          ...(monospace ? { fontFamily: MONO_FONT, fontSize: 12 } : {}),
        }}
      />
      {secure && allowReveal ? (
        <IconBtn
          icon={revealed ? "EyeOff" : "Eye"}
          label={revealed ? "隐藏密钥" : "显示密钥"}
          onPress={() => setRevealed((current) => !current)}
          size={26}
        />
      ) : null}
      {trailing}
    </View>
  );
  if (!label && !hint && !error) return input;
  return (
    <Field label={label ?? ""} hint={hint} error={error} required={required}>
      {input}
    </Field>
  );
}

export function SearchField({
  value,
  onChangeText,
  placeholder = "搜索",
  testID,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  testID?: string;
}) {
  const { theme, compact } = useLayout();
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        borderWidth: 1,
        borderColor: focused ? theme.colors.accent : theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 9,
        paddingHorizontal: 10,
        minHeight: compact ? 36 : 34,
        flex: 1,
        minWidth: 0,
      }}
    >
      <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
      <HostTextInput
        testID={testID}
        accessibilityLabel={placeholder}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCorrect={false}
        autoCapitalize="none"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          flex: 1,
          minWidth: 0,
          color: theme.colors.foreground,
          fontSize: 13,
          paddingVertical: 7,
        }}
      />
      {value ? (
        <IconBtn icon="X" label="清空搜索" onPress={() => onChangeText("")} size={24} />
      ) : null}
    </View>
  );
}

export function Sheet({
  open,
  onOpenChange,
  title,
  icon,
  children,
  footer,
  testID,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  testID?: string;
}) {
  const { theme, compact } = useLayout();
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} icon={icon}>
      <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }}>
        {/* Host modals mount their content in a separate root, so the screen's
            provider cannot be assumed. Re-provide theme/layout for body and footer. */}
        <UiProvider theme={theme} compact={compact}>
          <View
            testID={testID}
            style={{
              maxHeight: compact ? 430 : 590,
              minHeight: 180,
              backgroundColor: theme.colors.surface0,
            }}
          >
            <ScrollView
              style={{ flexShrink: 1 }}
              contentContainerStyle={{ padding: compact ? 16 : 20, gap: 12 }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {children}
            </ScrollView>
            {footer ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  flexWrap: "wrap",
                  gap: 8,
                  borderTopWidth: 1,
                  borderTopColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                  paddingHorizontal: compact ? 16 : 20,
                  paddingVertical: 11,
                }}
              >
                {footer}
              </View>
            ) : null}
          </View>
        </UiProvider>
      </Modal.Content>
    </Modal>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  onConfirm,
  onCancel,
  testID,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testID?: string;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
      title={title}
      icon={<Icon name="AlertTriangle" size={18} color={theme.colors.statusDanger} />}
    >
      <Modal.Content scrollable={false}>
        <UiProvider theme={theme} compact={compact}>
          <View testID={testID} style={{ gap: 16 }}>
            <Text style={[t.body, { color: theme.colors.foregroundMuted }]}>{description}</Text>
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              <Btn label="取消" onPress={onCancel} disabled={pending} />
              <Btn
                label={confirmLabel}
                onPress={onConfirm}
                variant="danger"
                pending={pending}
                testID={testID ? `${testID}-confirm` : undefined}
              />
            </View>
          </View>
        </UiProvider>
      </Modal.Content>
    </Modal>
  );
}

export function EmptyState({
  icon = "Boxes",
  title,
  description,
  action,
  testID,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  testID?: string;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  return (
    <View
      testID={testID}
      style={{
        alignItems: "center",
        justifyContent: "center",
        gap: 9,
        paddingVertical: compact ? 26 : 34,
        paddingHorizontal: 18,
      }}
    >
      <View
        style={{
          width: 42,
          height: 42,
          borderRadius: 21,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: withAlpha(theme.colors.accent, 0.1),
          borderWidth: 1,
          borderColor: withAlpha(theme.colors.accent, 0.2),
        }}
      >
        <Icon name={icon} size={20} color={theme.colors.accent} />
      </View>
      <Text style={[t.h3, { textAlign: "center" }]}>{title}</Text>
      {description ? (
        <Text style={[t.small, { textAlign: "center", maxWidth: 380 }]}>{description}</Text>
      ) : null}
      {action ? <View style={{ marginTop: 4 }}>{action}</View> : null}
    </View>
  );
}

export function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "danger" | "warning" | "accent";
  hint?: string;
}) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  const color =
    tone === "danger"
      ? theme.colors.statusDanger
      : tone === "warning"
        ? theme.colors.statusWarning
        : tone === "accent"
          ? theme.colors.accent
          : theme.colors.foreground;
  return (
    <View style={{ gap: 1, minWidth: 54 }}>
      <Text style={[t.tiny, { color: theme.colors.foregroundMuted }]}>{label}</Text>
      <Text
        style={{
          color,
          fontSize: compact ? 16 : 18,
          fontWeight: "700",
          fontVariant: ["tabular-nums"],
          lineHeight: 23,
        }}
      >
        {value}
      </Text>
      {hint ? <Text style={t.tiny}>{hint}</Text> : null}
    </View>
  );
}

export function KeyValue({ label, value }: { label: string; value: string }) {
  const { theme, compact } = useLayout();
  const t = useTokens(theme, compact);
  return (
    <View style={{ gap: 2, flex: 1, minWidth: 150 }}>
      <Text style={t.tiny}>{label}</Text>
      <Text style={[t.small, { color: theme.colors.foreground }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const toast = useToast();
  return (
    <Btn
      label={label}
      variant="ghost"
      size="sm"
      icon="Copy"
      onPress={() => {
        void copyText(text).then(
          () => toast.show("已复制", { variant: "success" }),
          () => toast.error("复制失败"),
        );
      }}
    />
  );
}
