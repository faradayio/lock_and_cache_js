import stableStringify from "json-stable-stringify";
import log from "./log";

/** Details of a serialized error. */
interface SerializedErrorDetails {
  name?: string;
  message?: string;
  stack?: string;
  [key: string]: unknown;
}

/**
 * A serialized error stored in the database.
 *
 * This can be either a full set of error details,
 */
type SerializedError = SerializedErrorDetails | string;

/**
 * Wrapper around a cached error result.
 *
 * If we try to calculate a value and cache it, but the calculation fails, we
 * store this value instead.
 */
interface LockAndCacheErrorWrapper {
  /** Magic field that indicates this is an error. */
  __lock_and_cache_error__: true;
  /** Information about the error. */
  err: SerializedError;
}

/**
 * Either data of type `T`, or a cached error that says why we couldn't compute
 * a value of type `T`.
 */
type DataOrErr<T> = T | LockAndCacheErrorWrapper;

/**
 * Valid cache keys.
 *
 * These may only contain values that we can serialize consistently.
 */
export type CacheKey =
  | string
  | number
  | boolean
  | null
  | CacheKey[]
  // Keys with a value of "undefined" will be omitted entirely.
  | { [key: string]: CacheKey | undefined };

/**
 * Serialize a cache key. Must not be used on objects.
 *
 * This should always return the same string for a given `key`.
 */
export function serializeKey(key: CacheKey): string {
  return stableStringify(key);
}

/** Serialize a value for caching. */
export function serializeValue(value: unknown): string {
  if (typeof value === "undefined") return "undefined";
  else return JSON.stringify(value);
}

/** Serialize an error for caching. */
export function serializeError(err: Error): string {
  log.error("caching error:", err);
  let serializedError: SerializedError;
  if (err instanceof Error) {
    serializedError = {};
    if (err.name) serializedError.name = err.name;
    if (err.message) serializedError.message = err.message;
    if (err.stack) serializedError.stack = err.stack;
  } else {
    serializedError = String(err);
  }
  return JSON.stringify({
    __lock_and_cache_error__: true,
    err: serializedError,
  });
}

/** Deserialize a value or error from the cache. */
export function deserializeValueOrError<T>(encoded: string): T {
  // If we see "undefined", assume it must have been a legal value of type `T`
  // and decode it.
  if (encoded === "undefined") return (undefined as unknown) as T;
  const decoded: DataOrErr<T> = JSON.parse(encoded);
  if (
    decoded !== null &&
    typeof decoded === "object" &&
    "__lock_and_cache_error__" in decoded
  ) {
    // We have a cached error.
    const err = new Error();
    Object.assign(err, decoded.err);
    throw err;
  } else {
    // We have a cached value.
    return decoded;
  }
}
