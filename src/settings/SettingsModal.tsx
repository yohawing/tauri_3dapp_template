import { useEffect, useRef } from "react";
import { CheckboxInput, CompactSelect } from "../components/controls/CompactControls";
import { CONSOLE_LEVELS, type ConsoleLevel, type Settings } from "./model";

export interface SettingsModalProps {
  open: boolean;
  settings: Settings;
  onChange: (settings: Settings) => void;
  onClose: () => void;
}

export function updateSettings(settings: Settings, update: (current: Settings) => Settings): Settings {
  // This helper keeps every control immediate while preserving the controlled
  // component contract expected by App. The parent owns persistence and the
  // consumers of the values.
  return update(settings);
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0,
  );
}

export function SettingsModal({ open, settings, onChange, onClose }: SettingsModalProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  const settingsRef = useRef(settings);
  onCloseRef.current = onClose;
  settingsRef.current = settings;

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active) || (!event.shiftKey && active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const commitSettings = (update: (current: Settings) => Settings) => {
    const next = updateSettings(settingsRef.current, update);
    settingsRef.current = next;
    onChange(next);
  };

  const setDebugOverlay = (debugOverlay: boolean) => {
    commitSettings((current) =>
      ({
        ...current,
        viewport: { ...current.viewport, debugOverlay },
      }),
    );
  };

  const setMinimumLevel = (minimumLevel: ConsoleLevel) => {
    commitSettings((current) =>
      ({
        ...current,
        console: { ...current.console, minimumLevel },
      }),
    );
  };

  const setAutoScroll = (autoScroll: boolean) => {
    commitSettings((current) =>
      ({
        ...current,
        console: { ...current.console, autoScroll },
      }),
    );
  };

  const interceptPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.currentTarget === event.target) onClose();
  };

  return (
    <div
      className="settings-modal__backdrop"
      role="presentation"
      onPointerDown={interceptPointer}
    >
      <section
        ref={dialogRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-modal__header">
          <h2 id="settings-modal-title" className="settings-modal__title">
            Settings
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="settings-modal__close"
            aria-label="Close Settings"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="settings-modal__body">
          <section className="settings-modal__section" aria-labelledby="settings-viewport-title">
            <h3 id="settings-viewport-title" className="settings-modal__section-title">
              Viewport
            </h3>
            <label className="settings-modal__checkbox-row">
              <CheckboxInput
                className="settings-modal__checkbox"
                checked={settings.viewport.debugOverlay}
                onChange={(event) => setDebugOverlay(event.currentTarget.checked)}
              />
              <span>Show debug overlay</span>
            </label>
          </section>

          <section className="settings-modal__section" aria-labelledby="settings-console-title">
            <h3 id="settings-console-title" className="settings-modal__section-title">
              Console
            </h3>
            <label className="settings-modal__field">
              <span className="settings-modal__label">Minimum level</span>
              <CompactSelect
                className="settings-modal__select"
                value={settings.console.minimumLevel}
                onChange={(event) => setMinimumLevel(event.currentTarget.value as ConsoleLevel)}
              >
                {CONSOLE_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level[0].toUpperCase() + level.slice(1)}
                  </option>
                ))}
              </CompactSelect>
            </label>
            <label className="settings-modal__checkbox-row">
              <CheckboxInput
                className="settings-modal__checkbox"
                checked={settings.console.autoScroll}
                onChange={(event) => setAutoScroll(event.currentTarget.checked)}
              />
              <span>Auto-scroll new entries</span>
            </label>
          </section>
        </div>

        <footer className="settings-modal__footer">
          <button type="button" className="settings-modal__button" onClick={onClose}>
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}
