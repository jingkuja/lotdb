import { describe, it, expect } from "vitest";
import {
  fitColumnWidth,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  textWidth,
  toTsv,
} from "../grid-utils";

describe("toTsv", () => {
  it("copies a single cell verbatim, NULL as nothing", () => {
    expect(toTsv([['a\tb\n"c"']])).toBe('a\tb\n"c"');
    expect(toTsv([[null]])).toBe("");
    expect(toTsv([[{ k: 1 }]])).toBe('{"k":1}');
  });

  it("quotes only the values that would break a block", () => {
    expect(
      toTsv([
        ["id", "note"],
        [1, 'say "hi"'],
        [2, "two\nlines"],
        [3, null],
      ]),
    ).toBe('id\tnote\n1\t"say ""hi"""\n2\t"two\nlines"\n3\t');
  });
});

describe("fitColumnWidth", () => {
  it("fits short columns to their header and caps long ones", () => {
    const id = fitColumnWidth("id", [1, 2, 3], 12);
    expect(id).toBe(MIN_COLUMN_WIDTH);
    const created = fitColumnWidth("created_at", ["2026-10-24 12:00:00"], 12);
    expect(created).toBeGreaterThan(textWidth("2026-10-24 12:00:00", 12));
    expect(created).toBeLessThan(MAX_COLUMN_WIDTH);
    expect(fitColumnWidth("t", ["x".repeat(500)], 12)).toBe(MAX_COLUMN_WIDTH);
  });

  it("counts CJK characters as full width", () => {
    expect(textWidth("中文", 12)).toBe(24);
    expect(textWidth("ab", 12)).toBeLessThan(textWidth("中文", 12));
  });
});
