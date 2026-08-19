import { describe, expect, it } from "vitest";
import { latestMaterialErrors } from "./Inspector";

describe("Inspector material command errors", () => {
  it("chooses latest sequence when Native results arrive out of order", () => {
    expect(latestMaterialErrors([
      { sequence: 10, nodeId: "cube", property: "metallic", applied: false, error: "old" },
      { sequence: 12, nodeId: "cube", property: "metallic", applied: true, error: null },
      { sequence: 11, nodeId: "cube", property: "roughness", applied: false, error: "roughness" },
      { sequence: 9, nodeId: "cube", property: "visibility", applied: false, error: "not material" },
    ], "cube")).toBe("roughness");
  });
});
