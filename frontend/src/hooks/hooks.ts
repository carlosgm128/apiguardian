import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import { applyEvent, initialRunState, type RunState } from "../state/runState";
import type { RunEvent } from "../types";

// ---- hash routing: #/  #/new  #/runs/:id/:tab -----------------------------

function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

export function navigate(...parts: string[]) {
  window.location.hash = "/" + parts.map(encodeURIComponent).join("/");
}

// ---- live run stream -------------------------------------------------------

export type Connection = "connecting" | "live" | "reconnecting";

/** Subscribes to a run's SSE stream; re-renders at most once per frame. */
export function useRunStream(runId: string): { state: RunState; version: number; connection: Connection } {
  const stateRef = useRef<RunState>(initialRunState());
  const [version, setVersion] = useState(0);
  const [connection, setConnection] = useState<Connection>("connecting");

  useEffect(() => {
    stateRef.current = initialRunState();
    setVersion((v) => v + 1);
    setConnection("connecting");
    let frame = 0;
    const source = new EventSource(api.eventsUrl(runId));
    source.onopen = () => setConnection("live");
    source.onerror = () => setConnection("reconnecting");
    source.onmessage = (msg) => {
      if (applyEvent(stateRef.current, JSON.parse(msg.data) as RunEvent) && !frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          setVersion((v) => v + 1);
        });
      }
    };
    return () => {
      source.close();
      cancelAnimationFrame(frame);
    };
  }, [runId]);

  return { state: stateRef.current, version, connection };
}

/** Current time, ticking while `active` (for growing timeline bars and timers). */
export function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/** Polls an async loader; `refresh` reloads immediately. */
export function usePoll<T>(load: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!intervalMs) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, intervalMs, ...deps]);

  return { data, error, refresh };
}
