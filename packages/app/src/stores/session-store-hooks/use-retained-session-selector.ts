import { useRef } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useSessionStore } from "../session-store";

type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

/**
 * Selects from the session store like `useSessionStore`, but while the enclosing retained panel is
 * hidden it keeps returning the value it last selected while visible. A hidden native chat stays
 * mounted (panels/retained-chat-content.tsx), and without this every stream commit of its agent
 * re-rendered it once per frame. Revealing the panel re-renders it, which selects live state again.
 *
 * `key` names whose state is selected; a hidden panel that switches to another key reads live state
 * once instead of showing the previous key's value.
 */
export function useRetainedSessionSelector<T>(
  key: string,
  select: (state: SessionStoreState) => T,
  equalityFn?: (left: T, right: T) => boolean,
): T {
  const active = useRetainedPanelActive();
  const retainedRef = useRef<{ key: string; value: T } | null>(null);
  // The retained value is read when the selector runs, not when it is created: a hidden panel
  // that had to read live state (on mount, or for a new key) must ignore the commits after it.
  const value = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const retained = retainedRef.current;
      return !active && retained?.key === key ? retained.value : select(state);
    },
    equalityFn,
  );
  if (active || retainedRef.current?.key !== key) retainedRef.current = { key, value };
  return value;
}
