import { useEffect, useRef, useState } from "react";
import {
  actionById,
  shortcutLabel,
  type EditorAction,
  type EditorActionId,
} from "../actions/editorActions";
import { boundedDiagnosticText } from "../console/contracts";

interface MenuBarProps {
  actions: readonly EditorAction[];
  backendLabel: string;
  documentLabel: string;
  isMac: boolean;
}

type OpenMenu = "file" | "view" | "renderer" | null;

const FILE_ACTIONS: readonly EditorActionId[] = [
  "file.new",
  "file.open",
  "file.import",
  "file.save",
  "file.saveAs",
];

const VIEW_ACTIONS: readonly EditorActionId[] = [
  "view.inspector.toggle",
  "view.console.toggle",
  "view.settings.open",
  "view.layout.reset",
];
const RENDERER_ACTIONS: readonly EditorActionId[] = ["renderer.native", "renderer.canvas"];

function reportMenuActionError(actionId: EditorActionId, error: unknown): void {
  const message = `Menu action ${actionId} failed: ${boundedDiagnosticText(error)}`;
  try {
    console.error(`[MenuBar] ${message}`);
  } catch {
    // A host-provided console must not turn action cleanup into a rejection.
  }
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent("tauri3d:diagnostic", {
        detail: { level: "error", source: "frontend", message },
      }));
    } catch {
      // Embedders may replace event dispatch; the menu has already closed.
    }
  }
}

export function runEditorActionSafely(action: EditorAction): Promise<void> {
  try {
    return Promise.resolve((action.run as unknown as () => void | PromiseLike<void>)())
      .catch((error) => reportMenuActionError(action.id, error));
  } catch (error) {
    reportMenuActionError(action.id, error);
    return Promise.resolve();
  }
}

export function MenuBar({ actions, backendLabel, documentLabel, isMac }: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const rootRef = useRef<HTMLElement>(null);
  const triggerRefs = useRef<Record<Exclude<OpenMenu, null>, HTMLButtonElement | null>>({
    file: null,
    view: null,
    renderer: null,
  });
  const itemRefs = useRef<Record<Exclude<OpenMenu, null>, Array<HTMLButtonElement | null>>>({
    file: [],
    view: [],
    renderer: [],
  });
  const initialFocusRef = useRef<Record<Exclude<OpenMenu, null>, number>>({
    file: 0,
    view: 0,
    renderer: 0,
  });

  const focusTrigger = (menu: Exclude<OpenMenu, null>) => {
    triggerRefs.current[menu]?.focus();
  };

  const focusMenuItem = (menu: Exclude<OpenMenu, null>, index: number) => {
    const items = itemRefs.current[menu];
    if (items.length === 0) return;
    for (let offset = 0; offset < items.length; offset += 1) {
      const next = (index + offset + items.length) % items.length;
      const item = items[next];
      if (item) {
        item.focus();
        return;
      }
    }
  };

  useEffect(() => {
    if (!import.meta.env.VITE_FILE_MENU_SELF_TEST) return;
    const timer = window.setTimeout(() => setOpenMenu("file"), 1200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        focusTrigger(openMenu);
        setOpenMenu(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    if (openMenu) focusMenuItem(openMenu, initialFocusRef.current[openMenu]);
  }, [openMenu]);

  const renderMenu = (menu: Exclude<OpenMenu, null>, ids: readonly EditorActionId[]) => (
    <div className="menu-bar__menu">
      <button
        id={`menu-trigger-${menu}`}
        ref={(element) => {
          triggerRefs.current[menu] = element;
        }}
        type="button"
        className={`menu-bar__trigger${openMenu === menu ? " menu-bar__trigger--open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={openMenu === menu}
        aria-controls={`menu-popup-${menu}`}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            initialFocusRef.current[menu] = event.key === "ArrowUp" ? -1 : 0;
            setOpenMenu(menu);
          }
        }}
        onClick={() => {
          initialFocusRef.current[menu] = 0;
          setOpenMenu((current) => (current === menu ? null : menu));
        }}
      >
        {menu === "file" ? "File" : menu === "view" ? "View" : "Renderer"}
      </button>
      {openMenu === menu && (
        <div
          id={`menu-popup-${menu}`}
          className="menu-popup"
          role="menu"
          aria-labelledby={`menu-trigger-${menu}`}
        >
          {ids.map((id, index) => {
            const action = actionById(actions, id);
            return (
              <button
                key={id}
                ref={(element) => {
                  itemRefs.current[menu][index] = action.enabled ? element : null;
                }}
                type="button"
                role="menuitem"
                className="menu-popup__item"
                disabled={!action.enabled}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    focusMenuItem(menu, index + 1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    focusMenuItem(menu, index - 1);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    focusMenuItem(menu, 0);
                  } else if (event.key === "End") {
                    event.preventDefault();
                    focusMenuItem(menu, ids.length - 1);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    focusTrigger(menu);
                    setOpenMenu(null);
                  }
                }}
                onClick={() => {
                  void runEditorActionSafely(action);
                  // The menu item is removed immediately below. Restore
                  // focus for both keyboard and pointer activation so a
                  // pointer click cannot leave focus on a detached node.
                  focusTrigger(menu);
                  setOpenMenu(null);
                }}
              >
                <span className="menu-popup__check" aria-hidden="true">
                  {action.checked ? "●" : ""}
                </span>
                <span>{action.label}</span>
                <span className="menu-popup__shortcut">
                  {action.shortcut ? shortcutLabel(action.shortcut, isMac) : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <nav ref={rootRef} className="menu-bar" aria-label="Application menu">
      <span className="menu-bar__title" title={documentLabel}>Tauri3D</span>
      {renderMenu("file", FILE_ACTIONS)}
      {renderMenu("view", VIEW_ACTIONS)}
      {renderMenu("renderer", RENDERER_ACTIONS)}
      <div className="menu-bar__renderer-toggle" role="group" aria-label="Renderer backend">
        {RENDERER_ACTIONS.map((id) => {
          const action = actionById(actions, id);
          const label = id === "renderer.native" ? "Native" : "Canvas";
          return (
            <button
              key={id}
              type="button"
              className={`menu-bar__renderer-button${action.checked ? " is-active" : ""}`}
              aria-pressed={action.checked}
              disabled={!action.enabled}
              onClick={() => { void runEditorActionSafely(action); }}
            >
              {label}
            </button>
          );
        })}
      </div>
      <span className="sr-only">Backend: {backendLabel}</span>
    </nav>
  );
}
