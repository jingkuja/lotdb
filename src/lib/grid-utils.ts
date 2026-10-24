// Pure helpers behind the data grid: cell text, clipboard text for a
// selected range, and column widths estimated from content.

export interface CellDisplayInfo {
  text: string;
  kind: "null" | "empty" | "normal";
}

export function cellDisplay(value: unknown): CellDisplayInfo {
  if (value === null || value === undefined)
    return { text: "NULL", kind: "null" };
  if (typeof value === "string" && value === "")
    return { text: "", kind: "empty" };
  if (typeof value === "boolean")
    return { text: value ? "true" : "false", kind: "normal" };
  if (typeof value === "object")
    return { text: JSON.stringify(value), kind: "normal" };
  return { text: String(value), kind: "normal" };
}

/** The text a cell contributes to the clipboard; NULL copies as nothing. */
export function cellClipboardText(value: unknown): string {
  const { text, kind } = cellDisplay(value);
  return kind === "null" ? "" : text;
}

/**
 * Tab-separated text for a block of cells, the format spreadsheets paste.
 * A single cell copies verbatim; in a block, a value containing a tab,
 * newline or quote is quoted the way Excel writes it.
 */
export function toTsv(block: unknown[][]): string {
  if (block.length === 1 && block[0]!.length === 1)
    return cellClipboardText(block[0]![0]);
  return block
    .map((row) =>
      row
        .map((value) => {
          const text = cellClipboardText(value);
          return /[\t\n\r"]/.test(text)
            ? `"${text.replace(/"/g, '""')}"`
            : text;
        })
        .join("\t"),
    )
    .join("\n");
}

/** Approximate rendered width of `text` at `fontPx`: wide (CJK) glyphs take a full em. */
export function textWidth(text: string, fontPx: number): number {
  let ems = 0;
  let n = 0;
  for (const ch of text) {
    if (++n > 120) break;
    const code = ch.codePointAt(0) ?? 0;
    ems += code >= 0x2e80 ? 1 : ch === " " ? 0.3 : 0.58;
  }
  return ems * fontPx;
}

export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 360;

/**
 * Width that shows the header and the sampled values of one column, within
 * [MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH]. Long text stays truncated rather
 * than pushing everything else off screen.
 */
export function fitColumnWidth(
  header: string,
  values: Iterable<unknown>,
  fontPx: number,
): number {
  // Header: padding plus the sort icon; cells: padding.
  let widest = textWidth(header, fontPx) + 36;
  let sampled = 0;
  for (const value of values) {
    if (++sampled > 200) break;
    widest = Math.max(widest, textWidth(cellDisplay(value).text, fontPx) + 20);
  }
  return Math.round(
    Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, widest)),
  );
}
