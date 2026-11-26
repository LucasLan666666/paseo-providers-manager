import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  actionRpc,
  snapshotRpc,
  type Action,
  type Operation,
  type Snapshot,
} from "../shared/contracts";
import { errorMessage } from "./format";
import { pick, type Lang } from "../shared/i18n";
import { useOperation } from "./useOperation";

export interface RunOptions {
  key?: string;
  toast?: boolean;
  reload?: boolean;
  /** Prepended to an error toast so failures stay in the UI's language. */
  errorPrefix?: string;
  /** Runs after a successful action and the snapshot reload. */
  onSuccess?: (result: Operation) => void;
}

export interface ManagerState {
  snapshot: Snapshot | null;
  loading: boolean;
  loadError: string | null;
  busy: string | null;
  autoRefreshing: boolean;
  autoRefreshError: string | null;
  reload: () => Promise<boolean>;
  refreshStale: (options?: { silent?: boolean }) => Promise<boolean>;
  run: (action: Action, options?: RunOptions) => Promise<boolean>;
}

/**
 * Loads the snapshot, kicks off the request's stale refresh on mount, and serializes
 * user actions through one busy key so every surface can show the right pending state.
 */
export function useManager(lang: Lang): ManagerState {
  // A ref, not a dependency: reload/refreshStale keep stable identities, so a
  // language switch never re-runs the mount effect (which refreshes gateways).
  const langRef = useRef(lang);
  langRef.current = lang;
  const fetchSnapshot = useRpc(snapshotRpc);
  const sendAction = useRpc(actionRpc);
  const complete = useOperation();
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const mounted = useRef(true);
  const rpc = useRef({ fetchSnapshot, sendAction });
  rpc.current = { fetchSnapshot, sendAction };
  const completeRef = useRef(complete);
  completeRef.current = complete;

  // Every action is wrapped: the daemon may answer with a job id for work that
  // outlives Paseo's 30s RPC timeout, and useOperation polls it to completion.
  const invoke = useCallback(async (action: Action) => {
    const started = rpc.current.sendAction({ ...action, lang: langRef.current });
    return completeRef.current(started, langRef.current);
  }, []);

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [autoRefreshing, setAutoRefreshing] = useState(false);
  const [autoRefreshError, setAutoRefreshError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<boolean> => {
    try {
      const next = await rpc.current.fetchSnapshot({ lang: langRef.current });
      if (mounted.current) {
        setSnapshot(next);
        setLoadError(null);
      }
      return true;
    } catch (error) {
      if (mounted.current) setLoadError(errorMessage(error, langRef.current));
      return false;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const refreshStale = useCallback(
    async (options: { silent?: boolean } = {}): Promise<boolean> => {
      setAutoRefreshing(true);
      try {
        const { message, level } = await invoke({ type: "refreshStale" });
        if (mounted.current) setAutoRefreshError(null);
        if (!options.silent && message.trim())
          toastRef.current.show(message, { variant: level ?? "success" });
        await reload();
        return true;
      } catch (error) {
        const detail = errorMessage(error, langRef.current);
        if (mounted.current) setAutoRefreshError(detail);
        if (!options.silent)
          toastRef.current.error(pick(langRef.current, "刷新过期连接失败：", "Refreshing stale connections failed: ") + detail);
        await reload();
        return false;
      } finally {
        if (mounted.current) setAutoRefreshing(false);
      }
    },
    [invoke, reload],
  );

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (async () => {
      await reload();
      if (cancelled) return;
      await refreshStale({ silent: true });
    })();
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [refreshStale, reload]);

  // Agent descriptions and stored messages come from the server in the request's
  // language: fetch the snapshot again (no gateway traffic) when it changes.
  const firstLang = useRef(true);
  useEffect(() => {
    if (firstLang.current) {
      firstLang.current = false;
      return;
    }
    void reload();
  }, [lang, reload]);

  const run = useCallback(
    async (action: Action, options: RunOptions = {}): Promise<boolean> => {
      setBusy(options.key ?? action.type);
      try {
        const result = await invoke(action);
        // Problems found by a check come back as a normal result, not an error;
        // show them as a warning instead of a green success toast.
        if (options.toast !== false && result.message.trim()) {
          toastRef.current.show(result.message, { variant: result.level ?? "success" });
        }
        if (options.reload !== false) await reload();
        options.onSuccess?.(result);
        return true;
      } catch (error) {
        const detail = errorMessage(error, langRef.current);
        toastRef.current.error(options.errorPrefix ? options.errorPrefix + pick(langRef.current, "：", ": ") + detail : detail);
        // Some handlers commit before throwing (for example a failed manual refresh).
        // Reload so the UI reflects the stored error instead of stale success state.
        await reload();
        return false;
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [invoke, reload],
  );

  return {
    snapshot,
    loading,
    loadError,
    busy,
    autoRefreshing,
    autoRefreshError,
    reload,
    refreshStale,
    run,
  };
}
