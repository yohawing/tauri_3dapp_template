export type EditorActionId =
  | "file.new"
  | "file.open"
  | "file.save"
  | "file.saveAs"
  | "renderer.native"
  | "renderer.canvas"
  | "view.inspector.toggle"
  | "view.console.toggle"
  | "view.settings.open"
  | "view.layout.reset";

export interface ShortcutSpec {
  code: string;
  primary: true;
  shift?: boolean;
}

export interface EditorAction {
  id: EditorActionId;
  label: string;
  shortcut?: ShortcutSpec;
  enabled: boolean;
  checked?: boolean;
  run: () => void;
}

export interface ShortcutEventLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

interface EditableTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  parentElement?: EditableTargetLike | null;
}

export function actionById(actions: readonly EditorAction[], id: EditorActionId): EditorAction {
  const action = actions.find((candidate) => candidate.id === id);
  if (!action) throw new Error(`missing editor action '${id}'`);
  return action;
}

export function shortcutMatches(
  shortcut: ShortcutSpec,
  event: ShortcutEventLike,
  isMac: boolean,
): boolean {
  const primaryPressed = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return (
    event.code === shortcut.code &&
    primaryPressed &&
    event.shiftKey === Boolean(shortcut.shift) &&
    !event.altKey
  );
}

export function findShortcutAction(
  actions: readonly EditorAction[],
  event: ShortcutEventLike,
  isMac: boolean,
): EditorAction | undefined {
  return actions.find(
    (action) =>
      action.enabled && action.shortcut !== undefined && shortcutMatches(action.shortcut, event, isMac),
  );
}

export function isEditableTarget(target: EventTarget | null): boolean {
  let current = target as EditableTargetLike | null;
  while (current) {
    const tagName = current.tagName?.toLowerCase();
    if (
      current.isContentEditable ||
      tagName === "input" ||
      tagName === "textarea" ||
      tagName === "select"
    ) {
      return true;
    }
    current = current.parentElement ?? null;
  }
  return false;
}

export function shortcutLabel(shortcut: ShortcutSpec, isMac: boolean): string {
  const key = shortcut.code.replace(/^Digit/, "").replace(/^Key/, "").toUpperCase();
  const modifiers = isMac ? ["⌘"] : ["Ctrl"];
  if (shortcut.shift) modifiers.push(isMac ? "⇧" : "Shift");
  return isMac ? `${modifiers.join("")} ${key}` : `${modifiers.join("+")}+${key}`;
}

export function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}
