import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { pick, resolveLang, type LanguageChoice } from "../shared/i18n";
import { useLanguage } from "./i18n";

/**
 * Settings → Plugins → Providers Manager. The option labels name each language
 * in itself, so they are readable whatever is currently selected.
 */
export function LanguageSettingsScreen(_props: PluginSurfaceProps) {
  const { settings, appLocale, lang } = useLanguage();
  const value: LanguageChoice = settings.status === "ready" ? settings.values.language : "system";
  const followed = resolveLang("system", appLocale) === "zh-CN" ? "简体中文" : "English";
  const options: Array<{ value: LanguageChoice; label: string }> = [
    { value: "system", label: `${pick(lang, "跟随 Paseo", "Follow Paseo")}（${followed}）` },
    { value: "zh-CN", label: "简体中文" },
    { value: "en", label: "English" },
  ];
  const error =
    settings.status === "error" || settings.status === "invalid" ? settings.error : settings.saveError;
  return (
    <SettingsSection title={pick(lang, "语言", "Language")}>
      <SettingsCard>
        <SettingsSelect
          label={pick(lang, "界面语言", "Interface language")}
          hint={pick(
            lang,
            "只影响本插件的界面和提示。“跟随 Paseo”使用 Paseo 的语言设置；此设置保存在当前设备上。",
            "Applies to this plugin's screens and messages only. “Follow Paseo” uses Paseo's language setting; the choice is stored on this device.",
          )}
          value={value}
          options={options}
          error={error}
          disabled={settings.status !== "ready" || settings.saving}
          onValueChange={(language) => {
            if (settings.status === "ready") void settings.save({ language }, settings.revision);
          }}
          testID="ppm-language"
        />
        {settings.status === "invalid" ? (
          <SettingsAction
            label={pick(lang, "设置已损坏", "The setting is damaged")}
            actionLabel={pick(lang, "重置", "Reset")}
            onPress={() => void settings.reset()}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
