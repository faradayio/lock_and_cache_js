import redis, { ClientOpts as RedisOpts } from "redis";

import { AsyncRedis } from "./asyncRedis";
import { Lock, LockError, LockExpiredError, LockTakenError } from "./lock";
import log from "./log";
import omit from "./omit";
import {
  CacheKey,
  serializeKey,
  serializeValue,
  serializeError,
  deserializeValueOrError,
} from "./serialization";

// Re-export things our users might want.
export { CacheKey, LockError, LockExpiredError, LockTakenError };

/**
 * A user-supplied function that computes a value to cache.
 *
 * This function may have an optional `displayName` property, which may be used
 * as part of the cache key if this function is passed to `wrap`.
 *
 * By default, `WorkFn` functions do not accept arguments, but if you're using
 * the `wrap` feature, you may want to supply an optional argument list.
 */
type WorkFn<T, Args extends CacheKey[] = []> = ((
  ...args: Args
) => Promise<T>) & {
  displayName?: string;
};

/** Default TTL for cached values, in seconds. */
const DEFAULT_TTL = 600;

/**
 * How long should we cache errors, in seconds?
 *
 * This may be too short.
 */
const ERROR_TTL = 1;

/** What Redis URL should we use by default? */
export function defaultRedisUrl(): string {
  return process.env.REDIS_URL || "redis://localhost:6379";
}

/** Default options for configuring our Redis client. */
export const DEFAULT_REDIS_LOCK_OPTS: RedisOpts = {
  retry_strategy(options) {
    return Math.min(options.attempt * 100, 3000);
  },
  url: process.env.LOCK_URL || defaultRedisUrl(),
};

/** Create a Redis client with `DEFAULT_REDIS_LOCK_OPTIONS`. */
function defaultRedisLockClient(): redis.RedisClient {
  log.trace("creating Redis lock client");
  return redis.createClient(DEFAULT_REDIS_LOCK_OPTS);
}

/** Default options for configuring our Redis client. */
export const DEFAULT_REDIS_CACHE_OPTS: RedisOpts = {
  retry_strategy(options) {
    return Math.min(options.attempt * 100, 3000);
  },
  url: process.env.CACHE_URL || defaultRedisUrl(),
};

/** Create a Redis client with `DEFAULT_REDIS_LOCK_OPTIONS`. */
function defaultRedisCacheClient(): redis.RedisClient {
  log.trace("creating Redis cache client");
  return redis.createClient(DEFAULT_REDIS_LOCK_OPTS);
}

/// Internal error thrown when we can't find a key in any of our caches.
class KeyNotFoundError extends Error {
  constructor(key: string) {
    super(`could not find key ${key}`);
  }
}

/** Options that can be passed to `get` and `wrap`. */
export type GetOptions = {
  /**
   * "Time to live." The time to cache a value, in seconds.
   *
   *  Defaults to `DEFAULT_TTL`.
   */
  ttl?: number;
};

/**
 * Cache expensive-to-compute values. Unlike typical caches, we take a Redis
 * lock to ensure that we only perform expensive computations once.
 *
 * Cached values may be stored locally or in Redis, but they are stored in
 * serialized form, and they are deserialized when returned from the cache.
 */
export class LockAndCache {
  /** The Redis client we use for locking. */
  private _lockClient: AsyncRedis;

  /** The Redis client we use for caching. */
  private _cacheClient: AsyncRedis;

  /**
   * Create a new `LockAndCache`.
   *
   * ```
   * const cache = LockAndCache()
   * try {
   *   const val = cache.get('key', async function () { return 'value' })
   * } finally {
   *   cache.close()
   * }
   * ```
   *
   * Note that if you don't call `close()` on all your caches, your program will
   * never never exit, because the Node `redis` module is like that.
   *
   * @param caches Caches to use. Defaults to `tieredCache()`.
   * @param lockClient Redis client to use for locking. Defaults to using
   * `DEFAULT_REDIS_OPTIONS`.
   */
  constructor({
    lockClient = defaultRedisLockClient(),
    cacheClient = defaultRedisCacheClient(),
  } = {}) {
    log.trace("creating LockAndCache");
    this._lockClient = new AsyncRedis(lockClient);
    this._cacheClient = new AsyncRedis(cacheClient);
  }

  /**
   * Try to fetch an item from our cache.
   *
   * Throws `KeyNotFoundError` if we don't have that key cached.
   */
  private async _cacheGet<T>(key: CacheKey): Promise<T> {
    const keyStr = serializeKey(key);
    const serializedValue = await this._cacheClient.get(keyStr);
    if (serializedValue === null) {
      throw new KeyNotFoundError(keyStr);
    }
    return deserializeValueOrError<T>(serializedValue);
  }

  /** Store serialized data in our cache. */
  private async _cacheSetSerialized(
    key: CacheKey,
    serializedData: string,
    ttl: number
  ): Promise<void> {
    const keyStr = serializeKey(key);
    const r = await this._cacheClient.set(keyStr, serializedData, "ex", ttl);
    if (r !== "OK")
      throw new Error(`error caching at ${keyStr}: ${JSON.stringify(r)}`);
  }

  /** Store a value in our cache. */
  private async _cacheSetValue(
    key: CacheKey,
    value: unknown,
    ttl: number
  ): Promise<void> {
    await this._cacheSetSerialized(key, serializeValue(value), ttl);
  }

  /** Store an error in our cache. */
  private async _cacheSetError(
    key: CacheKey,
    err: Error,
    ttl: number
  ): Promise<void> {
    await this._cacheSetSerialized(key, serializeError(err), ttl);
  }

  /**
   * Shut down this cache manager. No other functions may be called after this.
   */
  close(): void {
    log.debug("closing cache connections");
    this._lockClient
      .quit()
      .catch((err) => log.error("error quitting lock client", err));
    this._cacheClient
      .quit()
      .catch((err) => log.error("error quitting cache client", err));
  }

  /** Delete a key from our cache. */
  async delete(key: CacheKey): Promise<void> {
    await this._cacheClient.del(serializeKey(key));
  }

  /**
   * Either fetch a value from our cache, or compute it, cache it and return it.
   *
   * @param key The cache key to use.
   * @param options Cache options. `ttl` is in seconds.
   * @param work A function which performs an expensive caculation that we want
   * to cache.
   */
  async get<T>(
    key: CacheKey,
    options: GetOptions,
    work: WorkFn<T>
  ): Promise<T> {
    log.debug("get", key);
    const ttl = options.ttl != null ? options.ttl : DEFAULT_TTL;

    // See if we can find something in the cache without the overhead of taking
    // a lock.
    try {
      return await this._cacheGet<T>(key);
    } catch (err) {
      if (!(err instanceof KeyNotFoundError)) throw err;
    }

    // It looks like we need to take a lock.
    const lockKey = serializeKey(key);
    const lock = new Lock(this._lockClient, `lock:${lockKey}`);
    await lock.lock();
    try {
      // Now we have the lock. See if the last lock holder left us anything.
      try {
        return await this._cacheGet<T>(key);
      } catch (err) {
        if (!(err instanceof KeyNotFoundError)) throw err;
      }

      // Nope, nothing in the cache. We'll have to compute it, so keep this lock
      // for longer time.
      lock.extendIndefinitely();

      // Try running `work` and cache what we get.
      try {
        log.debug("calling work to compute value");
        const result = await work();
        await this._cacheSetValue(key, result, ttl);
        return result;
      } catch (err) {
        await this._cacheSetError(key, err, ERROR_TTL);
        throw err;
      }
    } finally {
      // Let go of our lock. This may throw an error if our lock extensions
      // failed.
      await lock.release();
    }
  }

  /**
   * Given a work function, wrap it in a `cache.get`, using the function's
   * arguments as part of our cache key.
   *
   * @param options Cache options. `name` is the base name of our cache key.
   * `ttl` is in seconds, and it defaults to `DEFAULT_TTL`.
   * @param work The work function to wrap. If `options.name` is not specified,
   * either `work.displayName` or `work.name` must be a non-empty string.
   */
  wrap<T, Args extends CacheKey[] = []>(
    options: GetOptions & { name?: string },
    work: WorkFn<T, Args>
  ): WorkFn<T, Args> {
    // Parse our options.
    let name: string;
    if (options.name != null) {
      name = options.name;
    } else {
      name = work.displayName || work.name;
    }
    if (name === "") {
      throw new Error(
        "cannot wrap an anonymous function without specifying `name`"
      );
    }
    const getOptions = omit(options, "name");

    log.debug("wrap", name);

    // Wrap our function.
    const wrappedFn = (...args: Args): Promise<T> => {
      log.debug("call wrapped", name, ...args);
      const key: CacheKey[] = [name];
      key.push(...args);
      return this.get(key, getOptions, () => work(...args));
    };
    wrappedFn.displayName = name;
    return wrappedFn;
  }
}
