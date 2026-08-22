/**
 * Backend error shaping.
 *
 * The Rust side returns `AppError` ({ code: "connection" | "sql" | "io",
 * message }) for query/data commands; everything else still rejects with a
 * plain string. These helpers work with both.
 */

export interface DbError {
  code: "connection" | "sql" | "io";
  message: string;
}

export function isDbError(e: unknown): e is DbError {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    "message" in e &&
    typeof (e as { message: unknown }).message === "string"
  );
}

/** Human-readable message for any rejected invoke() value. */
export function formatDbError(e: unknown): string {
  if (isDbError(e)) return e.message;
  return String(e);
}

/** Whether the failure is connection-class (offer one-click reconnect). */
export function isConnectionError(e: unknown): boolean {
  return isDbError(e) && e.code === "connection";
}
