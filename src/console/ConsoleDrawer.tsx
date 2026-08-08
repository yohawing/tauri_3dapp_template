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

const EMPTY_STATE: ConsoleState = {
  entries: [],
  capacity: 1,
  levelFilter: "all",
  autoScroll: true,
};

const EMPTY_SUBSCRIBE = (_listener: () => void): (() => void) => () => undefined;

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
        props.onAction(action);
      }
    },
    [props, store],
  );
  const [query, setQuery] = useState("");
  const visibleEntries = useMemo(
    () => selectVisibleConsoleEntries(state.entries, state.levelFilter).filter((entry) => {
      const needle = query.trim().toLocaleLowerCase();
      return needle.length === 0 || `${entry.source} ${entry.message}`.toLocaleLowerCase().includes(needle);
    }),
    [query, state.entries, state.levelFilter],
  );
  const listRef = useRef<HTMLOListElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [drawerHeight, setDrawerHeight] = useState(220);
  const resizeStartRef = useRef<{ pointerY: number; height: number } | null>(null);

  const handleResizePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    resizeStartRef.current = { pointerY: event.clientY, height: drawerHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [drawerHeight]);

  const handleResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    const next = start.height + start.pointerY - event.clientY;
    setDrawerHeight(Math.max(120, Math.min(window.innerHeight * 0.65, next)));
  }, []);

  const handleResizePointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    resizeStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

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
      if (props.onCopyAll) {
        await props.onCopyAll(text);
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("Clipboard API unavailable");
      }
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }, [props, state.entries]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 1500);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const className = ["console-drawer", props.className].filter(Boolean).join(" ");
  const copyLabel = copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy All";

  return (
    <section className={className} aria-label="Console diagnostics" style={{ height: drawerHeight }}>
      <div
        className="console-drawer__resize-handle"
        role="separator"
        aria-label="Resize Console"
        aria-orientation="horizontal"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
      />
      <header className="console-drawer__header">
        <div className="console-drawer__tabs" role="tablist" aria-label="Bottom panel">
          <button
            className="console-drawer__tab"
            type="button"
            role="tab"
            onClick={() => window.dispatchEvent(new CustomEvent("tauri3d:console-toggle", { detail: { open: false } }))}
          >
            Timeline
          </button>
          <button className="console-drawer__tab console-drawer__tab--active" type="button" role="tab" aria-selected="true">
            <span className="console-drawer__title-icon" aria-hidden="true">›_</span>
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
            onChange={(event) => setQuery(event.currentTarget.value)}
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

      <ol className="console-drawer__entries" ref={listRef} onScroll={handleScroll}>
        {visibleEntries.length === 0 ? (
          <li className="console-drawer__empty">No diagnostics in this view.</li>
        ) : (
          visibleEntries.map((entry, index) => (
            <li className={entryClassName(entry)} key={`${entry.timestamp}-${index}`}>
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
