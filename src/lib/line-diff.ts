/**
 * Simple LCS-based line-level diff.
 * Returns a sequence of hunks suitable for rendering a unified diff view.
 */

export type DiffKind = "same" | "removed" | "added";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** Line number in the left (original) file — 1-based, undefined for "added" */
  leftNo?: number;
  /** Line number in the right (current) file — 1-based, undefined for "removed" */
  rightNo?: number;
}

/** Compute LCS table for two string arrays. */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  // Use rolling array to save memory
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? (dp[i - 1]![j - 1]!) + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp;
}

/** Produce raw diff sequence from LCS table. */
function backtrack(
  dp: number[][],
  a: string[],
  b: string[],
): Array<{ kind: DiffKind; text: string }> {
  const result: Array<{ kind: DiffKind; text: string }> = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ kind: "same", text: a[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.unshift({ kind: "added", text: b[j - 1]! });
      j--;
    } else {
      result.unshift({ kind: "removed", text: a[i - 1]! });
      i--;
    }
  }
  return result;
}

/**
 * Diff two SQL strings line by line.
 * Returns DiffLine[] with left/right line numbers.
 */
export function diffLines(leftSql: string, rightSql: string): DiffLine[] {
  const a = leftSql.split("\n");
  const b = rightSql.split("\n");
  const dp = lcsTable(a, b);
  const raw = backtrack(dp, a, b);

  let leftNo = 1;
  let rightNo = 1;
  return raw.map((r) => {
    if (r.kind === "same") {
      return { ...r, leftNo: leftNo++, rightNo: rightNo++ };
    } else if (r.kind === "removed") {
      return { ...r, leftNo: leftNo++ };
    } else {
      return { ...r, rightNo: rightNo++ };
    }
  });
}

/**
 * Group DiffLine[] into context-aware hunks for display.
 * Adjacent same lines beyond `context` are collapsed into a "..." separator.
 */
export interface DiffHunk {
  lines: DiffLine[];
}

export function buildHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  // Find indices of changed lines
  const changed = new Set<number>();
  lines.forEach((l, i) => {
    if (l.kind !== "same") changed.add(i);
  });

  if (changed.size === 0) return [];

  // Expand context around each changed line
  const visible = new Set<number>();
  for (const idx of changed) {
    for (
      let k = Math.max(0, idx - context);
      k <= Math.min(lines.length - 1, idx + context);
      k++
    ) {
      visible.add(k);
    }
  }

  // Build hunks
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffLine[] = [];
  let prevIdx = -2;

  const sortedVisible = [...visible].sort((a, b) => a - b);

  for (const idx of sortedVisible) {
    if (idx > prevIdx + 1 && currentHunk.length > 0) {
      hunks.push({ lines: currentHunk });
      currentHunk = [];
    }
    currentHunk.push(lines[idx]!);
    prevIdx = idx;
  }
  if (currentHunk.length > 0) {
    hunks.push({ lines: currentHunk });
  }

  return hunks;
}
