import { describe, expect, it } from "vitest";
import type { EditorAction } from "../actions/editorActions";
import { runEditorActionSafely } from "./MenuBar";

const action = (run: EditorAction["run"]): EditorAction => ({
  id: "view.console.toggle",
  label: "Console",
  enabled: true,
  run,
});

describe("MenuBar action runner", () => {
  it("absorbs synchronous throws and Promise rejections", async () => {
    await expect(runEditorActionSafely(action(() => {
      throw new Error("sync failure");
    }))).resolves.toBeUndefined();
    await expect(runEditorActionSafely(action(() => Promise.reject(new Error("async failure"))))).resolves.toBeUndefined();
  });
});
