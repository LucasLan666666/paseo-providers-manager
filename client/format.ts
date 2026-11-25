import type { Capacity, Protocol } from "../shared/contracts";
import { protocolInfo } from "../shared/protocols";

/** Refresh data older than this is considered stale in the UI. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "发生未知错误，请稍后重试。";
}

export function formatTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000_000) return trimDecimal(value / 1_000_000_000) + "B";
  if (value >= 1_000_000) return trimDecimal(value / 1_000_000) + "M";
  if (value >= 1_000) return trimDecimal(value / 1_000) + "K";
  return String(value);
}

function trimDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatTokensFull(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Raw editable representation, without separators so inputs round-trip. */
export function rawTokens(value: number | null | undefined): string {
  return value == null ? "" : String(value);
}

export function formatRelativeTime(timestamp: number | null | undefined, now = Date.now()): string {
  if (timestamp == null) return "从未刷新";
  const delta = now - timestamp;
  if (delta < 0) return "刚刚";
  if (delta < 60_000) return "刚刚";
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))} 小时前`;
  if (delta < 30 * 24 * 60 * 60_000) return `${Math.floor(delta / (24 * 60 * 60_000))} 天前`;
  const date = new Date(timestamp);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export function refreshLabel(timestamp: number | null | undefined, now = Date.now()): string {
  return timestamp == null ? "从未刷新" : `${formatRelativeTime(timestamp, now)}刷新`;
}

export function isStale(timestamp: number | null | undefined, now = Date.now()): boolean {
  if (timestamp == null) return true;
  return now - timestamp > STALE_AFTER_MS;
}

export interface ParsedTokens {
  value?: number;
  error?: string;
}

/**
 * Parses human token amounts: "200000", "200,000", "128k", "1.5m".
 * A blank string has no value and no error; callers decide if blank is allowed.
 */
export function parseTokens(input: string): ParsedTokens {
  const text = input.trim().replace(/[,_\s]/g, "").toLowerCase();
  if (!text) return {};
  const match = /^(\d+(?:\.\d+)?)([kmb])?$/.exec(text);
  if (!match) return { error: "请输入正整数，例如 200000 或 200K" };
  const amount = Number(match[1]);
  const suffix = match[2];
  const multiplier = suffix === "b" ? 1_000_000_000 : suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const value = Math.round(amount * multiplier);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { error: "请输入大于 0 的整数" };
  }
  return { value };
}

/** Short protocol name for badges, e.g. "OpenAI Chat". */
export function protocolLabel(protocol: Protocol): string {
  return protocolInfo[protocol].short;
}

/** Full protocol name for choices, e.g. "OpenAI Chat Completions". */
export function protocolFullLabel(protocol: Protocol): string {
  return protocolInfo[protocol].label;
}

/** The request the gateway must serve for this protocol. */
export function protocolDescription(protocol: Protocol): string {
  return protocolInfo[protocol].endpoint;
}

export function sourceLabel(source: Capacity["source"]): string {
  return source === "gateway" ? "网关" : "目录";
}

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  if (set.size !== right.length) return false;
  return right.every((value) => set.has(value));
}

