import { describe, expect, it } from "vitest";
import { boundSearchQuery, MAX_SEARCH_QUERY_BYTES, normalizeSearchQuery } from "../searchQuery";

describe("Outliner search query bounds", () => {
  it("trims whitespace and keeps UTF-8 bytes within the UI cap", () => {
    const query = normalizeSearchQuery(`  ${"あ".repeat(2_000)}  `);

    expect(query).not.toMatch(/^\s|\s$/u);
    expect(new TextEncoder().encode(query).byteLength).toBeLessThanOrEqual(MAX_SEARCH_QUERY_BYTES);
    expect(query).not.toContain("�");
  });

  it("does not split emoji when bounding a long query", () => {
    const query = normalizeSearchQuery("😀".repeat(2_000));

    expect(new TextEncoder().encode(query).byteLength).toBeLessThanOrEqual(MAX_SEARCH_QUERY_BYTES);
    expect(query).toBe("😀".repeat(1_024));
  });

  it("keeps normal short queries case-insensitive", () => {
    expect(normalizeSearchQuery("  Cube  ")).toBe("cube");
  });

  it("keeps the controlled input text separate from matching normalization", () => {
    expect(boundSearchQuery("  Cube  ")).toBe("  Cube  ");
    expect(normalizeSearchQuery(boundSearchQuery("  Cube  "))).toBe("cube");
  });

  it("re-applies the byte cap after locale lowercasing expands characters", () => {
    const query = normalizeSearchQuery("İ".repeat(2_048));

    expect(new TextEncoder().encode(query).byteLength).toBeLessThanOrEqual(MAX_SEARCH_QUERY_BYTES);
  });
});
