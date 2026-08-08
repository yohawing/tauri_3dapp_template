import { useEffect } from "react";
import { CheckboxInput, CompactSelect } from "../components/controls/CompactControls";
import { CONSOLE_LEVELS, type ConsoleLevel, type Settings } from "./model";

export interface SettingsModalProps {
  open: boolean;
  settings: Settings;
  onChange: (settings: Settings) => void;
  onClose: () => void;
}

function updateSettings(settings: Settings, update: (current: Settings) => void): void {
  // This helper keeps every control immediate while preserving the controlled
  // component contract expected by App. The parent owns persistence and the
  // consumers of the values.
  update(settings);
}

export function SettingsModal({ open, settings, onChange, onClose }: SettingsModalProps) {
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const setDebugOverlay = (debugOverlay: boolean) => {
    updateSettings(settings, (current) =>
      onChange({
        ...current,
        viewport: { ...current.viewport, debugOverlay },
      }),
    );
  };

  const setMinimumLevel = (minimumLevel: ConsoleLevel) => {
    updateSettings(settings, (current) =>
      onChange({
        ...current,
        console: { ...current.console, minimumLevel },
      }),
    );
  };

  const setAutoScroll = (autoScroll: boolean) => {
    updateSettings(settings, (current) =>
      onChange({
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
