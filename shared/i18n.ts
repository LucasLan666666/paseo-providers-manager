import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const langs = ["zh-CN", "en"] as const;
export type Lang = (typeof langs)[number];
export const langSchema = z.enum(langs);

export const languageChoices = ["system", "zh-CN", "en"] as const;
export type LanguageChoice = (typeof languageChoices)[number];

/**
 * The plugin's own language. Device scope: "follow Paseo" follows the app
 * language, which is a per-device setting too; the value lives in the client's
 * storage and needs no daemon registration.
 */
export const languageSettings = defineSettings({
  id: "language",
  scope: "device",
  version: 1,
  schema: z.object({ language: z.enum(languageChoices).default("system") }),
});

/**
 * Paseo reports its language as one of en, ar, es, fr, ja, ko, pt-BR, ru or
 * zh-CN (zh / zh-Hans map to zh-CN). Chinese → 简体中文, anything else → English.
 */
export function resolveLang(choice: LanguageChoice, appLocale?: string): Lang {
  if (choice !== "system") return choice;
  return appLocale?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** The text for a language; every call site carries both, so nothing is left untranslated. */
export function pick(lang: Lang, zh: string, en: string): string {
  return lang === "en" ? en : zh;
}
