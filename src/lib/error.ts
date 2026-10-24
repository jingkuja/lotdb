/**
 * Backend error shaping.
 *
 * Every Rust command rejects with `AppError` ({ code: "connection" | "sql" |
 * "io", message }). The invoke wrapper in services/tauri-commands turns it
 * into a `DbError`; strings can still arrive from Tauri itself (e.g. an
 * argument that fails to deserialize). These helpers work with both.
 */

export type DbErrorCode = "connection" | "sql" | "io";

export class DbError extends Error {
  readonly code: DbErrorCode;

  constructor(code: DbErrorCode, message: string) {
    super(message);
    this.name = "DbError";
    this.code = code;
  }

  /** `String(e)` and template literals show just the message. */
  override toString(): string {
    return this.message;
  }
}

export function isDbError(
  e: unknown,
): e is { code: DbErrorCode; message: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    "message" in e &&
    typeof (e as { message: unknown }).message === "string"
  );
}

/** Rejected invoke() value → DbError when it has the AppError shape. */
export function toDbError(e: unknown): unknown {
  if (e instanceof DbError || !isDbError(e)) return e;
  return new DbError(e.code, e.message);
}

/** Human-readable message for any rejected invoke() value. */
export function formatDbError(e: unknown): string {
  if (isDbError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Whether the failure is connection-class (offer one-click reconnect). */
export function isConnectionError(e: unknown): boolean {
  return isDbError(e) && e.code === "connection";
}
