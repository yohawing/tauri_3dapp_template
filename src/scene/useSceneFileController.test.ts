import { describe, expect, it } from "vitest";
import {
  shouldAcceptSceneStatus,
} from "./useSceneFileController";

describe("scene file status generations", () => {
  it("accepts the current request and rejects an older startup response", () => {
    expect(shouldAcceptSceneStatus(4, 4)).toBe(true);
    expect(shouldAcceptSceneStatus(3, 4)).toBe(false);
    expect(shouldAcceptSceneStatus(5, 4)).toBe(true);
  });

  it("suppresses a late startup rejection after a newer status was accepted", () => {
    expect(shouldAcceptSceneStatus(1, 2)).toBe(false);
  });
});
