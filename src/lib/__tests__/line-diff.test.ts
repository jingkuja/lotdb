import { describe, it, expect } from "vitest";
import { diffLines, buildHunks } from "../line-diff";

describe("diffLines", () => {
  it("identical text produces all-same lines", () => {
    const lines = diffLines("a\nb\nc", "a\nb\nc");
    expect(lines.every((l) => l.kind === "same")).toBe(true);
    expect(lines).toHaveLength(3);
  });

  it("detects added lines", () => {
    const lines = diffLines("a\nb", "a\nb\nc");
    const added = lines.filter((l) => l.kind === "added");
    expect(added).toHaveLength(1);
    expect(added[0]!.text).toBe("c");
  });

  it("detects removed lines", () => {
    const lines = diffLines("a\nb\nc", "a\nb");
    const removed = lines.filter((l) => l.kind === "removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]!.text).toBe("c");
  });

  it("assigns correct left/right line numbers", () => {
    const lines = diffLines("x\ny", "x\nz\ny");
    // x → same (left=1, right=1)
    // z → added (right=2)
    // y → same (left=2, right=3)
    const same = lines.filter((l) => l.kind === "same");
    expect(same[0]!.leftNo).toBe(1);
    expect(same[0]!.rightNo).toBe(1);
    expect(same[1]!.leftNo).toBe(2);
    expect(same[1]!.rightNo).toBe(3);

    const added = lines.filter((l) => l.kind === "added");
    expect(added[0]!.rightNo).toBe(2);
    expect(added[0]!.leftNo).toBeUndefined();
  });

  it("empty left = all added", () => {
    const lines = diffLines("", "a\nb");
    // first line is "" vs "a" — let's just check no "removed"
    const removed = lines.filter((l) => l.kind === "removed");
    // empty string will appear as one removed empty line; "a" and "b" as added
    const added = lines.filter((l) => l.kind === "added");
    expect(added.some((l) => l.text === "a")).toBe(true);
    expect(added.some((l) => l.text === "b")).toBe(true);
    expect(removed.length).toBeLessThanOrEqual(1); // at most the empty first line
  });
});

describe("buildHunks", () => {
  it("returns empty array when no changes", () => {
    const lines = diffLines("a\nb\nc", "a\nb\nc");
    expect(buildHunks(lines)).toHaveLength(0);
  });

  it("groups nearby changes into one hunk", () => {
    // Change line 5 of 10 — context=3 should produce 1 hunk
    const a = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const b = Array.from({ length: 10 }, (_, i) =>
      i === 4 ? "CHANGED" : `line${i + 1}`,
    ).join("\n");
    const lines = diffLines(a, b);
    const hunks = buildHunks(lines, 3);
    expect(hunks).toHaveLength(1);
    const hunkLines = hunks[0]!.lines;
    expect(hunkLines.some((l) => l.kind === "removed")).toBe(true);
    expect(hunkLines.some((l) => l.kind === "added")).toBe(true);
  });

  it("produces two hunks for distant changes", () => {
    // Change line 1 and line 20 with context=2 — should be 2 separate hunks
    const arr = Array.from({ length: 22 }, (_, i) => `line${i + 1}`);
    arr[0] = "CHANGED_A";
    arr[19] = "CHANGED_B";
    const a = Array.from({ length: 22 }, (_, i) => `line${i + 1}`).join("\n");
    const b = arr.join("\n");
    const hunks = buildHunks(diffLines(a, b), 2);
    expect(hunks).toHaveLength(2);
  });
});
