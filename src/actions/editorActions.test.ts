import { describe, expect, it, vi } from "vitest";
import {
  actionById,
  findShortcutAction,
  isEditableTarget,
  isMacPlatform,
  shortcutLabel,
  shortcutMatches,
  type EditorAction,
  type ShortcutEventLike,
} from "./editorActions";

const keyEvent = (overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike => ({
  code: "Digit1",
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

const action = (enabled = true): EditorAction => ({
  id: "renderer.native",
  label: "Native",
  shortcut: { code: "Digit1", primary: true },
  enabled,
  run: vi.fn(),
});

describe("editor actions", () => {
  it("looks up the finite action id and fails closed for a missing definition", () => {
    expect(actionById([action()], "renderer.native").label).toBe("Native");
    expect(() => actionById([], "renderer.native")).toThrow("missing editor action");
  });

  it("matches the platform primary modifier and exact optional modifiers", () => {
    expect(shortcutMatches({ code: "Digit1", primary: true }, keyEvent(), false)).toBe(true);
    expect(shortcutMatches({ code: "Digit1", primary: true }, keyEvent({ metaKey: true }), false)).toBe(false);
    expect(shortcutMatches({ code: "Digit1", primary: true }, keyEvent({ ctrlKey: false, metaKey: true }), true)).toBe(true);
    expect(shortcutMatches({ code: "Digit0", primary: true, shift: true }, keyEvent({ code: "Digit0", shiftKey: true }), false)).toBe(true);
    expect(shortcutMatches({ code: "Digit0", primary: true, shift: true }, keyEvent({ code: "Digit0" }), false)).toBe(false);
  });

  it("returns only enabled registered shortcuts", () => {
    expect(findShortcutAction([action(false)], keyEvent(), false)).toBeUndefined();
    expect(findShortcutAction([action(true)], keyEvent(), false)?.id).toBe("renderer.native");
  });

  it("excludes editable targets and their descendants", () => {
    expect(isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "span", parentElement: { isContentEditable: true } } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "button" } as unknown as EventTarget)).toBe(false);
  });

  it("formats current shortcuts while keeping platform detection local", () => {
    expect(shortcutLabel({ code: "KeyI", primary: true }, false)).toBe("Ctrl+I");
    expect(shortcutLabel({ code: "Digit0", primary: true, shift: true }, true)).toBe("⌘⇧ 0");
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("Win32")).toBe(false);
  });
});
