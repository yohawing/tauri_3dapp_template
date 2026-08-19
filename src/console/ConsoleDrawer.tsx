import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  selectVisibleConsoleEntries,
  type ConsoleEntry,
  type ConsoleFilter,
} from "./contracts";
import {
  type ConsoleAction,
  type ConsoleState,
  type ConsoleStore,
  formatConsoleEntries,
} from "./state";
import { boundSearchQuery, normalizeSearchQuery } from "../searchQuery";
import { focusLazyPanelHost } from "../components/LazyPanelBoundary";

const EMPTY_STATE: ConsoleState = {
  entries: [],
  capacity: 1,
  levelFilter: "all",
  autoScroll: true,
};

const EMPTY_SUBSCRIBE = (_listener: () => void): (() => void) => () => undefined;
const CONSOLE_DRAWER_MIN_HEIGHT = 120;
const CONSOLE_DRAWER_KEYBOARD_STEP = 16;

export function isActiveConsoleResizePointer(activePointerId: number | null, pointerId: number): boolean {
  return activePointerId === pointerId;
}

const consoleEntryKeys = new WeakMap<ConsoleEntry, number>();
let nextConsoleEntryKey = 1;

function consoleEntryKey(entry: ConsoleEntry): number {
  const existing = consoleEntryKeys.get(entry);
  if (existing !== undefined) return existing;
  const key = nextConsoleEntryKey++;
  consoleEntryKeys.set(entry, key);
  return key;
}

export function formatConsoleLiveAnnouncement(entry: ConsoleEntry | undefined, additional: boolean): string {
  if (!entry) return "Console cleared.";
  const prefix = additional ? "Another" : "New";
  return `${entry.timestamp}: ${prefix} ${entry.level} diagnostic from ${entry.source}.`;
}

/** Stable across appends while remaining unique if one object is repeated. */
export function consoleEntryRenderKeys(entries: readonly ConsoleEntry[]): string[] {
  const occurrences = new Map<ConsoleEntry, number>();
  return entries.map((entry) => {
    const occurrence = occurrences.get(entry) ?? 0;
    occurrences.set(entry, occurrence + 1);
    return `${consoleEntryKey(entry)}:${occurrence}`;
  });
}

export function getConsoleDrawerMaxHeight(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight)) return CONSOLE_DRAWER_MIN_HEIGHT;
  return Math.max(CONSOLE_DRAWER_MIN_HEIGHT, viewportHeight * 0.65);
}

export function clampConsoleDrawerHeight(value: number, maxHeight: number): number {
  const upperBound = Math.max(CONSOLE_DRAWER_MIN_HEIGHT, maxHeight);
  if (!Number.isFinite(value)) return CONSOLE_DRAWER_MIN_HEIGHT;
  return Math.max(CONSOLE_DRAWER_MIN_HEIGHT, Math.min(upperBound, value));
}

export function consoleDrawerHeightForKey(
  key: string,
  currentHeight: number,
  maxHeight: number,
): number | null {
  const upperBound = Math.max(CONSOLE_DRAWER_MIN_HEIGHT, maxHeight);
  switch (key) {
    case "ArrowUp":
      return clampConsoleDrawerHeight(currentHeight + CONSOLE_DRAWER_KEYBOARD_STEP, upperBound);
    case "ArrowDown":
      return clampConsoleDrawerHeight(currentHeight - CONSOLE_DRAWER_KEYBOARD_STEP, upperBound);
    case "Home":
      return CONSOLE_DRAWER_MIN_HEIGHT;
    case "End":
      return upperBound;
    default:
      return null;
  }
}

export type ConsoleDrawerProps =
  | {
      /** A model-owned store. The drawer subscribes and dispatches directly. */
      readonly store: ConsoleStore;
      readonly state?: never;
      readonly onAction?: never;
      readonly className?: string;
      readonly onCopyAll?: (text: string) => void | Promise<void>;
    }
  | {
      /** Controlled mode for apps that already own a state container. */
      readonly store?: never;
      readonly state: ConsoleState;
      readonly onAction: (action: ConsoleAction) => void;
      readonly className?: string;
      readonly onCopyAll?: (text: string) => void | Promise<void>;
    };

function entryClassName(entry: ConsoleEntry): string {
  return `console-drawer__entry console-drawer__entry--${entry.level}`;
}

function filterLabel(filter: ConsoleFilter): string {
  return filter === "all" ? "All" : `${filter[0].toUpperCase()}${filter.slice(1)}+`;
}

export function ConsoleDrawer(props: ConsoleDrawerProps) {
  const store = props.store;
  const controlledState = props.state;
  const onAction = props.onAction;
  const onCopyAll = props.onCopyAll;
  const customClassName = props.className;
  const getSnapshot = useCallback(
    () => store?.getState() ?? controlledState ?? EMPTY_STATE,
    [controlledState, store],
  );
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? EMPTY_SUBSCRIBE(listener),
    [store],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const dispatch = useCallback(
    (action: ConsoleAction) => {
      if (store) {
        store.dispatch(action);
      } else {
        onAction?.(action);
      }
    },
    [onAction, store],
  );
  const [query, setQuery] = useState("");
  const visibleEntries = useMemo(
    () => {
      const needle = normalizeSearchQuery(query);
      return selectVisibleConsoleEntries(state.entries, state.levelFilter).filter((entry) =>
        needle.length === 0 || `${entry.source} ${entry.message}`.toLocaleLowerCase().includes(needle),
      );
    },
    [query, state.entries, state.levelFilter],
  );
  const visibleEntryKeys = useMemo(() => consoleEntryRenderKeys(visibleEntries), [visibleEntries]);
  const listRef = useRef<HTMLOListElement>(null);
  const previousEntriesRef = useRef(state.entries);
  const liveAnnouncementAdditionalRef = useRef(false);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const mountedRef = useRef(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [drawerHeight, setDrawerHeight] = useState(220);
  const resizeStartRef = useRef<{ pointerY: number; height: number } | null>(null);
  const resizePointerIdRef = useRef<number | null>(null);
  const maxDrawerHeight = getConsoleDrawerMaxHeight(
    typeof window === "undefined" ? Number.NaN : window.innerHeight,
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleResizePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (resizePointerIdRef.current !== null) return;
    resizeStartRef.current = { pointerY: event.clientY, height: drawerHeight };
    resizePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [drawerHeight]);

  const handleResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isActiveConsoleResizePointer(resizePointerIdRef.current, event.pointerId)) return;
    const start = resizeStartRef.current;
    if (!start) return;
    const next = start.height + start.pointerY - event.clientY;
    setDrawerHeight(clampConsoleDrawerHeight(next, getConsoleDrawerMaxHeight(window.innerHeight)));
  }, []);

  const handleResizePointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isActiveConsoleResizePointer(resizePointerIdRef.current, event.pointerId)) return;
    resizeStartRef.current = null;
    resizePointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleResizeLostPointerCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isActiveConsoleResizePointer(resizePointerIdRef.current, event.pointerId)) return;
    resizeStartRef.current = null;
    resizePointerIdRef.current = null;
  }, []);

  const handleResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const next = consoleDrawerHeightForKey(event.key, drawerHeight, maxDrawerHeight);
    if (next === null) return;
    event.preventDefault();
    setDrawerHeight(next);
  }, [drawerHeight, maxDrawerHeight]);

  useEffect(() => {
    const previousEntries = previousEntriesRef.current;
    previousEntriesRef.current = state.entries;
    if (previousEntries === state.entries) return;
    const latest = state.entries.at(-1);
    if (!latest) {
      liveAnnouncementAdditionalRef.current = false;
      setLiveAnnouncement(formatConsoleLiveAnnouncement(undefined, false));
      return;
    }
    const additional = liveAnnouncementAdditionalRef.current;
    liveAnnouncementAdditionalRef.current = !additional;
    setLiveAnnouncement(formatConsoleLiveAnnouncement(latest, additional));
  }, [state.entries]);

  useEffect(() => {
    if (!state.autoScroll || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [state.autoScroll, state.entries, state.levelFilter]);

  const handleScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 8;
    if (atBottom !== state.autoScroll) {
      dispatch({ type: "setAutoScroll", enabled: atBottom });
    }
  }, [dispatch, state.autoScroll]);

  const handleCopyAll = useCallback(async () => {
    const text = formatConsoleEntries(state.entries);
    try {
      if (onCopyAll) {
        await onCopyAll(text);
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("Clipboard API unavailable");
      }
      if (mountedRef.current) setCopyState("copied");
    } catch {
      if (mountedRef.current) setCopyState("failed");
    }
  }, [onCopyAll, state.entries]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 1500);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const className = ["console-drawer", customClassName].filter(Boolean).join(" ");
  const copyLabel = copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy All";

  return (
    <section className={className} aria-label="Console diagnostics" style={{ height: drawerHeight }}>
      <div
        className="console-drawer__resize-handle"
        role="separator"
        aria-label="Resize Console"
        aria-orientation="horizontal"
        aria-valuemin={CONSOLE_DRAWER_MIN_HEIGHT}
        aria-valuemax={maxDrawerHeight}
        aria-valuenow={clampConsoleDrawerHeight(drawerHeight, maxDrawerHeight)}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
        onLostPointerCapture={handleResizeLostPointerCapture}
        onKeyDown={handleResizeKeyDown}
      />
      <header className="console-drawer__header">
        <div className="console-drawer__tabs" role="group" aria-label="Bottom panel">
          <button
            className="console-drawer__tab"
            type="button"
            aria-pressed="false"
            onClick={(event) => {
              focusLazyPanelHost(event.currentTarget);
              window.dispatchEvent(new CustomEvent("tauri3d:console-toggle", { detail: { open: false } }));
            }}
          >
            Timeline
          </button>
          <button className="console-drawer__tab console-drawer__tab--active" type="button" aria-pressed="true">
            Console
          </button>
          <span className="console-drawer__count" aria-label={`${state.entries.length} entries`}>
            {state.entries.length}
          </span>
        </div>
        <div className="console-drawer__controls">
          <div className="console-drawer__filter" role="group" aria-label="Console level filter">
            {(["all", "info", "warn", "error"] as const).map((filter) => (
              <button
                key={filter}
                className={`console-drawer__filter-button${state.levelFilter === filter ? " is-active" : ""}`}
                type="button"
                aria-pressed={state.levelFilter === filter}
                onClick={() => dispatch({ type: "setFilter", filter })}
              >
                {filterLabel(filter).replace("+", "")}
              </button>
            ))}
          </div>
          <input
            className="console-drawer__search"
            aria-label="Filter console messages"
            type="search"
            placeholder="Filter…"
            value={query}
            onChange={(event) => setQuery(boundSearchQuery(event.currentTarget.value))}
          />
          <button className="console-drawer__button" type="button" onClick={handleCopyAll}>
            {copyLabel}
          </button>
          <button className="console-drawer__button" type="button" onClick={() => dispatch({ type: "clear" })}>
            Clear
          </button>
          <button
            className={`console-drawer__button console-drawer__button--autoscroll${state.autoScroll ? " is-active" : ""}`}
            type="button"
            aria-pressed={state.autoScroll}
            onClick={() => dispatch({ type: "setAutoScroll", enabled: !state.autoScroll })}
          >
            Auto-scroll
          </button>
        </div>
      </header>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {liveAnnouncement}
      </div>
      <ol className="console-drawer__entries" ref={listRef} onScroll={handleScroll}>
        {visibleEntries.length === 0 ? (
          <li className="console-drawer__empty">No diagnostics in this view.</li>
        ) : (
          visibleEntries.map((entry, index) => (
            <li className={entryClassName(entry)} key={visibleEntryKeys[index]}>
              <time className="console-drawer__timestamp" dateTime={entry.timestamp}>{entry.timestamp}</time>
              <span className="console-drawer__level">{entry.level}</span>
              <span className="console-drawer__source">{entry.source}</span>
              <span className="console-drawer__message">{entry.message}</span>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}
