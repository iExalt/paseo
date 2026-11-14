import { inspect } from "node:util";

/**
 * Convert unknown thrown values into a user-safe error string.
 */
export function getErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return typeof error === "object" && error !== null ? inspect(error) : String(error);
}
