import redis, { ClientOpts as RedisOptions, RedisClient } from "redis";
import Redlock from "redlock";
import assert = require("assert");

/** Default options that we pass to Redis. */
const DEFAULT_REDIS_OPTIONS: RedisOptions = {
  retry_strategy(options) {
    return Math.min(options.attempt * 100, 3000);
  },
};

const ERROR_TTL = 1;

/**
 * Get the value associated with a Redis key, and parse it as JSON.
 */
function redisGet<T>(client: RedisClient, key: string): Promise<T> {
  return new Promise(function lookup(resolve, reject) {
    client.get(key, function onGet(err, value) {
      if (err) {
        reject(err);
      } else if (value === null) {
        reject("key not found");
      } else if (value === "undefined") {
        resolve(undefined);
      } else {
        resolve(JSON.parse(value));
      }
    });
  });
}

/**
 * Set the value associated with a Redis key, serialzing it as JSON.
 */
function redisSet<T>(
  client: RedisClient,
  key: string,
  ttl: number,
  value: T
): Promise<T> {
  return new Promise(function set(resolve, reject) {
    let storedValue;
    if (typeof value === "undefined") {
      storedValue = "undefined";
    } else {
      storedValue = JSON.stringify(value);
    }
    client.setex(key, ttl, storedValue, function onSet(err) {
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    });
  });
}

/** Internal function used to decrement a reference count. */
type UnrefFn = () => void;

/** Internal locker state. */
type Locker = [RedisClient, Redlock, UnrefFn];

/** A function which creates a new `Locker`. */
type GetLockerFn = () => Locker;

/**
 * A user-supplied function that computes a value to cache.
 *
 * This function may have an optional `displayName` property, which may be used
 * as part of the cache key if this function is passed to `wrap`.
 *
 * By default, `WorkFn` functions do not accept arguments, but if you're using
 * the `wrap` feature, you may want to supply an optional argument list.
 */
type WorkFn<T, Args extends unknown[] = []> = ((
  ...args: Args
) => Promise<T>) & {
  displayName?: string;
};

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

/** Internal cache helper. */
function lockAndCache<T>(
  getLocker: GetLockerFn,
  keyValue: unknown,
  ttl: number,
  work: WorkFn<T>
): Promise<T> {
  const key = JSON.stringify(keyValue);

  const locker = getLocker();
  const cacheClient = locker[0];
  const redlock = locker[1];
  const unref = locker[2];

  let lock: Redlock.Lock | undefined;
  let value: DataOrErr<T> | undefined;
  let done: boolean | undefined;
  let extendTimeout: NodeJS.Timeout | undefined;

  function extend() {
    if (lock && !done) {
      lock.extend(5000, function onExtend(err) {
        if (lock && !done) {
          extendTimeout = setTimeout(extend, err ? 500 : 2500);
        }
      });
    }
  }

  function cleanup() {
    done = true;
    if (extendTimeout) clearTimeout(extendTimeout);
    unref();
    return lock ? lock.unlock() : Promise.resolve();
  }

  return redisGet<DataOrErr<T>>(cacheClient, key)
    .catch(function onErr(err) {
      if (err !== "key not found") throw err;
      return redlock
        .lock("lock:" + key, 5000)
        .then(function onLock(_lock) {
          extendTimeout = setTimeout(extend, 2500);
          lock = _lock;
          return redisGet<DataOrErr<T>>(cacheClient, key);
        })
        .catch(function onLockErr(err) {
          if (err !== "key not found") throw err;
          return work()
            .catch(function onWorkErr(err): LockAndCacheErrorWrapper {
              ttl = ERROR_TTL;
              let serializedError: SerializedError;
              if (err instanceof Error) {
                serializedError = {};
                if (err.name) serializedError.name = err.name;
                if (err.message) serializedError.message = err.message;
                if (err.stack) serializedError.stack = err.stack;
                Object.assign(serializedError, err); // retain custom properties
              } else {
                serializedError = String(err);
              }
              return {
                __lock_and_cache_error__: true,
                err: serializedError,
              };
            })
            .then(function onWorkDone(data) {
              return redisSet<DataOrErr<T>>(cacheClient, key, ttl, data);
            });
        });
    })
    .then(function onValue(_value) {
      value = _value;
      return cleanup();
    })
    .then(function onCleanup() {
      if (
        typeof value === "object" &&
        value !== null &&
        "__lock_and_cache_error__" in value
      ) {
        if (typeof value.err === "object") {
          const err = new Error();
          Object.assign(err, value.err);
          throw err;
        } else {
          throw new Error(value.err);
        }
      }
      // We know this has to be a `T` at this point, because it was set by
      // `value = _value` above.
      return value as T;
    })
    .catch(function (err) {
      return cleanup().then(function throwErr() {
        throw err;
      });
    });
}

/** Options for configuring `lock_and_cache`. */
export type Options = Redlock.Options & {
  /**
   * Redis server to use for caching values, if different from our lock servers.
   */
  cacheServer?: string;
};

/**
 * The type of the `cache` function exported by `lock_and_cache`, or returned by
 * `configure`.
 *
 * This is fairly exotic TypeScript type, because there's a lot going on here:
 *
 * 1. `cache` is a function which can be called for multiple cached types `T`.
 * 2. `cache.wrap` will wrap a function, and it can be called two different
 *    ways.
 */
export interface CacheFn {
  /**
   * If you call this function directly, it will cache the result of `work()`.
   *
   * ```
   * function getStockQuote(symbol: string) {
   *   return cache(['stock', symbol], 60, async () => {
   *     // fetch stock price from remote source, cache for one minute
   *     // calling this multiple times in parallel will only run it once
   *   });
   * }
   * ```
   *
   * The `<T>(..., work: WorkFn<T>): Promise<T>` syntax is an advanced
   * TypeScript feature which says you can call this function with different
   * types of work functions, and the cache will return a value of the same
   * type.
   *
   * @param keyValue The value to use as a cache key. This will be serialized as
   * JSON.
   * @param ttl The number of seconds the cached value should live.
   * @param work A function which returns a value of type `Promise<T>`.
   */
  <T>(keyValue: unknown, ttl: number, work: WorkFn<T>): Promise<T>;

  /**
   * Wrap `work` so that its results are cached.
   *
   * ```
   * const getStockQuote = cache.wrap("stock", 60, async (symbol: string) => {
   *   // fetch stock price from remote source, cache for one minute
   *   // calling this multiple times in parallel will only run it once
   *   // the cache key is based on the function name and arguments
   * });
   * ```
   *
   * @param name The name of the function we're caching.
   * @param ttl The number of seconds the cached value should live.
   * @param work The function to wrap. If this takes arguments, those
   * arguments will also be available on the wrapped function.
   */
  wrap<T, Args extends unknown[]>(
    name: string,
    ttl: number,
    work: WorkFn<T, Args>
  ): WorkFn<T, Args>;

  /**
   * Wrap `work` so that its results are cached.
   *
   * ```
   * const getStockQuote = cache.wrap(60, async function stock (symbol: string) {
   *   // fetch stock price from remote source, cache for one minute
   *   // calling this multiple times in parallel will only run it once
   *   // the cache key is based on the function name and arguments
   * });
   * ```
   *
   * @param ttl The number of seconds the cached value should live.
   * @param work The function to wrap. This should be a named function, or
   * it should define `displayName`. If this takes arguments, those
   * arguments will also be available on the wrapped function.
   */
  wrap<T, Args extends unknown[]>(
    ttl: number,
    work: WorkFn<T, Args>
  ): WorkFn<T, Args>;
}

/** Create a new `cache` function using the specified parameters. */
lockAndCache.configure = function (
  serverOrServers: string | string[],
  opts: Options
): CacheFn {
  let servers: string[];
  if (Array.isArray(serverOrServers)) {
    servers = serverOrServers;
  } else {
    servers = [serverOrServers];
  }

  let refs = 0;
  let cleanupTimeout: NodeJS.Timeout | null | undefined;
  let clients: RedisClient[] | null | undefined;
  let cacheClient: RedisClient | undefined;
  let redlock: Redlock | null | undefined;

  let seperateCacheServer = false;
  if (opts.cacheServer != null) {
    seperateCacheServer = true;
    servers.push(opts.cacheServer);
    delete opts.cacheServer;
  }

  function tryToCleanUp() {
    if (refs === 0 && !cleanupTimeout && clients) {
      cleanupTimeout = setTimeout(
        function reap() {
          assert(clients != null, "expected to have clients to clean up");
          clients.forEach((c) => c.quit());
          if (seperateCacheServer) {
            assert(
              cacheClient != null,
              "expected to have a cacheServer to clean up"
            );
            cacheClient.quit();
          }
          redlock = clients = cleanupTimeout = null;
        },
        process.env.NODE_ENV === "test" ? 50 : 30000
      );
    }
  }

  function getLocker(): Locker {
    if (cleanupTimeout) {
      clearTimeout(cleanupTimeout);
      cleanupTimeout = null;
    }
    refs++;

    let unrefd = false;
    function unref() {
      if (unrefd) return;
      unrefd = true;
      refs--;
      tryToCleanUp();
    }

    if (!clients) {
      clients = servers.map(function (server) {
        return redis.createClient(server, DEFAULT_REDIS_OPTIONS);
      });
      redlock = new Redlock(clients, opts);
      if (seperateCacheServer) {
        cacheClient = clients.pop();
      } else {
        cacheClient = clients[0];
      }
    }

    assert(cacheClient != null, "expected to have a cacheClient");
    assert(redlock != null, "expected to have redlock");
    return [cacheClient, redlock, unref];
  }

  // Declare a wrapper function manually instead of using `bind`, so that we
  // preserve the type parameter `T` in the finished function.
  function cache<T>(
    keyValue: unknown,
    ttl: number,
    work: WorkFn<T>
  ): Promise<T> {
    return lockAndCache(getLocker, keyValue, ttl, work);
  }

  // Support overloaded `wrap` for backwards compatibility.
  function wrap<T, Args extends unknown[]>(
    name: string,
    ttl: number,
    work: WorkFn<T, Args>
  ): WorkFn<T, Args>;
  function wrap<T, Args extends unknown[]>(
    ttl: number,
    work: WorkFn<T, Args>
  ): WorkFn<T, Args>;
  function wrap<T, Args extends unknown[]>(
    nameOrTtl: unknown,
    ttlOrWork: unknown,
    maybeWork?: WorkFn<T, Args>
  ): WorkFn<T> {
    let name: string;
    let ttl: number;
    let work: WorkFn<T, Args>;
    if (
      typeof nameOrTtl === "string" &&
      typeof ttlOrWork === "number" &&
      maybeWork
    ) {
      name = nameOrTtl;
      ttl = ttlOrWork;
      work = maybeWork;
    } else if (
      typeof nameOrTtl === "number" &&
      typeof ttlOrWork === "function"
    ) {
      ttl = nameOrTtl;
      // Trust our overloaded type declaration to have ensured a real
      // `WorkFn<T, Args>` here.
      work = ttlOrWork as WorkFn<T, Args>;
      name = work.displayName || work.name;
    } else {
      throw new Error("unexpected parameters passed to cache.wrap");
    }

    if (name === "") {
      // a man needs a name
      throw new Error(
        "cannot do lockAndCache.wrap(work) on an anonymous function"
      );
    }

    assert(typeof name === "string", "name should be string");
    assert(typeof ttl === "number", "ttl should be number");
    assert(typeof work === "function", "work should be function");

    const wrappedFn: WorkFn<T, Args> = (...args: Args) => {
      const key = [name as unknown].concat(args);
      return cache<T>(key, ttl, function doWork(): Promise<T> {
        return work(...args);
      });
    };
    wrappedFn.displayName = name;

    return wrappedFn;
  }

  // Finish assembling our object and apply our exotic `CacheFn` type.
  return Object.assign(cache, { wrap });
};

function defaultLockUrl(): string {
  const url = process.env.LOCK_URL || process.env.REDIS_URL;
  if (url == null) {
    throw new Error("expected LOCK_URL or REDIS_URL to be set");
  }
  return url;
}

function defaultCacheUrl(): string {
  const url = process.env.CACHE_URL || process.env.REDIS_URL;
  if (url == null) {
    throw new Error("expected CACHE_URL or REDIS_URL to be set");
  }
  return url;
}

/**
 * Our basic `cache` function. This can be called as `cache(...)` or
 * `cache.wrap(...)`.
 */
export default lockAndCache.configure(defaultLockUrl(), {
  cacheServer: defaultCacheUrl(),
  driftFactor: Number(process.env.LOCK_DRIFT_FACTOR) || undefined,
  retryCount: Number(process.env.LOCK_RETRY_COUNT) || 36000,
  retryDelay: Number(process.env.LOCK_RETRY_DELAY) || 100,
});

/** Create a new `cache` function using the specified parameters. */
export const configure = lockAndCache.configure;
