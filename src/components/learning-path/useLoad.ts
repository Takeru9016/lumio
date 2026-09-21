"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Loading = { kind: "loading" };

/**
 * Runs one read and holds its answer. `key` names what is being read (a path id,
 * a filter and a cursor): a new key starts a new read and drops the old answer, so
 * the screen shows its skeleton rather than another page's data. A read that is
 * superseded, or abandoned on unmount, is aborted and can never overwrite a newer
 * answer.
 *
 * `reload` is a retry after a failure and shows the skeleton again. `refresh` is a
 * re-read after a change: the current answer stays on screen until the new one
 * arrives, and the promise resolves with it.
 */
export function useLoad<R extends { kind: string }>(
  load: (signal: AbortSignal) => Promise<R>,
  key: string
): {
  state: R | Loading;
  reload: () => Promise<R | null>;
  refresh: () => Promise<R | null>;
} {
  const [state, setState] = useState<R | Loading>({ kind: "loading" });
  const loadRef = useRef(load);
  loadRef.current = load;
  const latest = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const run = useCallback(async (keepCurrent: boolean): Promise<R | null> => {
    const id = ++latest.current;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    if (!keepCurrent) setState({ kind: "loading" });
    try {
      const answer = await loadRef.current(next.signal);
      if (id !== latest.current) return null;
      setState(answer);
      return answer;
    } catch {
      return null;
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the trigger, it is deliberately not read inside
  useEffect(() => {
    void run(false);
    return () => {
      latest.current += 1;
      controller.current?.abort();
    };
  }, [key, run]);

  const reload = useCallback(() => run(false), [run]);
  const refresh = useCallback(() => run(true), [run]);
  return { state, reload, refresh };
}
