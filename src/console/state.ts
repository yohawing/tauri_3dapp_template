import {
  type ConsoleEntry,
  type ConsoleFilter,
  formatConsoleEntries,
} from "./contracts";

export const DEFAULT_CONSOLE_CAPACITY = 500;

export interface ConsoleState {
  readonly entries: readonly ConsoleEntry[];
  /** The maximum number of entries retained for this session. */
  readonly capacity: number;
  /** Minimum level shown by the UI; `all` shows every retained entry. */
  readonly levelFilter: ConsoleFilter;
  /** Whether the drawer follows new entries when they arrive. */
  readonly autoScroll: boolean;
}

export type ConsoleAction =
  | { readonly type: "append"; readonly entry: ConsoleEntry }
  | { readonly type: "appendMany"; readonly entries: readonly ConsoleEntry[] }
  | { readonly type: "clear" }
  | { readonly type: "setFilter"; readonly filter: ConsoleFilter }
  | { readonly type: "setAutoScroll"; readonly enabled: boolean };

export interface ConsoleStateOptions {
  readonly capacity?: number;
  readonly levelFilter?: ConsoleFilter;
  readonly autoScroll?: boolean;
}

function normalizeCapacity(capacity: number): number {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("Console capacity must be a positive safe integer");
  }
  return capacity;
}

export function createConsoleState(options: ConsoleStateOptions = {}): ConsoleState {
  return {
    entries: [],
    capacity: normalizeCapacity(options.capacity ?? DEFAULT_CONSOLE_CAPACITY),
    levelFilter: options.levelFilter ?? "all",
    autoScroll: options.autoScroll ?? true,
  };
}

function appendEntries(
  current: readonly ConsoleEntry[],
  incoming: readonly ConsoleEntry[],
  capacity: number,
): readonly ConsoleEntry[] {
  if (incoming.length === 0) return current;
  const combined = current.concat(incoming);
  return combined.length <= capacity ? combined : combined.slice(combined.length - capacity);
}

export function reduceConsoleState(state: ConsoleState, action: ConsoleAction): ConsoleState {
  switch (action.type) {
    case "append": {
      const entries = appendEntries(state.entries, [action.entry], state.capacity);
      return entries === state.entries ? state : { ...state, entries };
    }
    case "appendMany": {
      const entries = appendEntries(state.entries, action.entries, state.capacity);
      return entries === state.entries ? state : { ...state, entries };
    }
    case "clear":
      return state.entries.length === 0 ? state : { ...state, entries: [] };
    case "setFilter":
      return state.levelFilter === action.filter ? state : { ...state, levelFilter: action.filter };
    case "setAutoScroll":
      return state.autoScroll === action.enabled ? state : { ...state, autoScroll: action.enabled };
  }
}

export interface ConsoleStore {
  getState(): ConsoleState;
  subscribe(listener: () => void): () => void;
  dispatch(action: ConsoleAction): void;
  append(entry: ConsoleEntry): void;
  appendMany(entries: readonly ConsoleEntry[]): void;
  clear(): void;
  setFilter(filter: ConsoleFilter): void;
  setAutoScroll(enabled: boolean): void;
}

/**
 * A tiny synchronous external store.  It keeps the model independent from
 * React while still being directly consumable by useSyncExternalStore.
 */
export function createConsoleStore(options: ConsoleStateOptions = {}): ConsoleStore {
  let state = createConsoleState(options);
  const listeners = new Set<() => void>();

  const dispatch = (action: ConsoleAction) => {
    const next = reduceConsoleState(state, action);
    if (next === state) return;
    state = next;
    listeners.forEach((listener) => listener());
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    append: (entry) => dispatch({ type: "append", entry }),
    appendMany: (entries) => dispatch({ type: "appendMany", entries }),
    clear: () => dispatch({ type: "clear" }),
    setFilter: (filter) => dispatch({ type: "setFilter", filter }),
    setAutoScroll: (enabled) => dispatch({ type: "setAutoScroll", enabled }),
  };
}

/** Convenience helper for parents that need clipboard text without importing
 * the React drawer. */
export { formatConsoleEntries };

export type { ConsoleEntry, ConsoleFilter, ConsoleLevel } from "./contracts";
