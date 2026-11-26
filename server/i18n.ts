import { AsyncLocalStorage } from "node:async_hooks";
import type { Lang } from "../shared/i18n";

/**
 * The language of the RPC being served. Each handler runs inside `withLang`,
 * and every message built while it runs (errors, toasts, test results, agent
 * descriptions) uses that language. Manager.serial chains its work with
 * `.then` inside the caller's context, so queued actions keep their caller's
 * language. Requests without a language (older clients, tests) get Chinese,
 * the plugin's original language.
 */
const current = new AsyncLocalStorage<Lang>();

export function withLang<T>(lang: Lang | undefined, fn: () => T): T {
  return current.run(lang ?? "zh-CN", fn);
}

export function currentLang(): Lang {
  return current.getStore() ?? "zh-CN";
}

/** The message in the current request's language. */
export function L(zh: string, en: string): string {
  return currentLang() === "en" ? en : zh;
}

/** "1 model" / "3 models" for the English side of a message. */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
