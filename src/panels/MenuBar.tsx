import { useEffect, useRef, useState } from "react";
import {
  actionById,
  shortcutLabel,
  type EditorAction,
  type EditorActionId,
} from "../actions/editorActions";

interface MenuBarProps {
  actions: readonly EditorAction[];
  backendLabel: string;
  isMac: boolean;
}

type OpenMenu = "view" | "renderer" | null;

const VIEW_ACTIONS: readonly EditorActionId[] = [
  "view.inspector.toggle",
  "view.console.toggle",
  "view.settings.open",
  "view.layout.reset",
];
const RENDERER_ACTIONS: readonly EditorActionId[] = ["renderer.native", "renderer.canvas"];

export function MenuBar({ actions, backendLabel, isMac }: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
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

  const renderMenu = (menu: Exclude<OpenMenu, null>, ids: readonly EditorActionId[]) => (
    <div className="menu-bar__menu">
      <button
        type="button"
        className={`menu-bar__trigger${openMenu === menu ? " menu-bar__trigger--open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={openMenu === menu}
        onClick={() => setOpenMenu((current) => (current === menu ? null : menu))}
      >
        {menu === "view" ? "View" : "Renderer"}
      </button>
      {openMenu === menu && (
        <div className="menu-popup" role="menu">
          {ids.map((id) => {
            const action = actionById(actions, id);
            return (
              <button
                key={id}
                type="button"
                role="menuitem"
                className="menu-popup__item"
                disabled={!action.enabled}
                onClick={() => {
                  action.run();
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
      <span className="menu-bar__title">Tauri3D</span>
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
              onClick={action.run}
            >
              {label}
            </button>
          );
        })}
      </div>
      <span className="menu-bar__backend">Backend: {backendLabel}</span>
    </nav>
  );
}
