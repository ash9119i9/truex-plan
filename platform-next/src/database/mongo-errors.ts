import {
  MongoClientBulkWriteError,
  MongoNetworkError,
  MongoServerError,
  MongoServerSelectionError,
  MongoTopologyClosedError,
} from "mongodb";

const DUPLICATE_KEY = 11000;

// Also true for a client bulkWrite that stopped on a duplicate key: that
// error carries the code on its write error, not on itself.
export function isDuplicateKeyError(error: unknown): error is MongoServerError {
  if (error instanceof MongoClientBulkWriteError)
    return [...error.writeErrors.values()].some(
      (write) => write.code === DUPLICATE_KEY,
    );
  return error instanceof MongoServerError && error.code === DUPLICATE_KEY;
}

// The name of the unique index a duplicate-key error came from, when reported.
export function duplicateKeyFields(error: MongoServerError): string[] {
  const pattern: unknown = error.keyPattern;
  return typeof pattern === "object" && pattern !== null
    ? Object.keys(pattern)
    : [];
}

// MongoDB cannot be reached: a dependency outage the caller can retry, not a
// bug in this app.
export function isDatabaseUnavailableError(error: unknown): boolean {
  return (
    error instanceof MongoServerSelectionError ||
    error instanceof MongoNetworkError ||
    // Not yet (re)connected; see DatabaseService.
    error instanceof MongoTopologyClosedError
  );
}
