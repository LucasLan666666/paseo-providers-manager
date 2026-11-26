import { defineTranslations, useSettings, useTranslation } from "@getpaseo/plugin/client";
import { useEffect } from "react";
import { languageSettings, resolveLang, type Lang, type LanguageChoice } from "../shared/i18n";

/**
 * Labels Paseo draws itself (the settings tab, the command-center item). They
 * follow Paseo's language, which is also how the app reports its locale to us.
 */
export const hostLabels = defineTranslations({
  resources: {
    en: { language: "Language", openLanguage: "Providers Manager: language" },
    "zh-CN": { language: "语言", openLanguage: "Providers Manager：语言" },
  },
});

// Last known choice for this client bundle, so a remounted screen does not
// flash the "follow Paseo" language while the device setting loads.
let lastChoice: LanguageChoice = "system";

/** Call at surface roots only; components below read `lang` from UiProvider (useTr). */
export function useLanguage(): {
  lang: Lang;
  choice: LanguageChoice;
  appLocale: string;
  /** False while the device setting is still being read (a different language may follow). */
  ready: boolean;
  settings: ReturnType<typeof useSettings<typeof languageSettings.schema>>;
} {
  const settings = useSettings(languageSettings);
  // useTranslation re-renders when Paseo's language changes.
  const { locale: appLocale } = useTranslation(hostLabels);
  const choice = settings.status === "ready" ? settings.values.language : lastChoice;
  useEffect(() => {
    if (settings.status === "ready") lastChoice = settings.values.language;
  }, [settings]);
  return {
    lang: resolveLang(choice, appLocale),
    choice,
    appLocale,
    ready: settings.status !== "loading",
    settings,
  };
}
