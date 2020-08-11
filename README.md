# lock_and_cache

Lock and cache using Redis!

Most caching libraries don't do locking, meaning that >1 process can be calculating a cached value at the same time. Since you presumably cache things because they cost CPU, database reads, or money, doesn't it make sense to lock while caching?

## Quickstart

```ts
import { LockAndCache } from "../lib";

const cache = new LockAndCache();

// Standalone mode.
function getStockQuote(symbol: string) {
  return cache.get(["stock", symbol], { ttl: 60 }, async () => {
    // Fetch stock price from remote source, cache for one minute.
    //
    // Calling this multiple times in parallel will only run it once.
    return 100;
  });
}

// Wrap mode
async function stockQuoteHelper(symbol: string) {
  // Fetch stock price from remote source, cache for one minute.
  //
  // Calling this multiple times in parallel will only run it once the cache key
  // is based on the function name and arguments.
  return 100;
}
const stockQuote = cache.wrap({ ttl: 60 }, stockQuoteHelper);

// If you forget this, your process will never exit.
cache.close();
```

## Install

```sh
npm install --save lock_and_cache
```

## Theory

lock_and_cache...

1. returns cached value (if exists)
2. acquires a lock
3. returns cached value (just in case it was calculated while we were waiting for a lock)
4. calculates and caches the value
5. releases the lock
6. returns the value

As you can see, most caching libraries only take care of (1) and (4) (well, and (5) of course).

## Setup

Just setting REDIS_URL in your environment is enough.

```sh
export REDIS_URL=redis://redis:6379/2
```

If you want to put the cache and the locks in different places (which is useful if you want to invalidate the cache without messing with any locks currently held), you can do:

```sh
export CACHE_URL=redis://redis:6379/2
export LOCK_URL=redis://redis:6379/3
```

## API

We have full JSDoc for this library, but these are the highlights at the time of writing.

```ts
/**
 * Valid cache keys.
 *
 * These may only contain values that we can serialize consistently.
 */
export type CacheKey = string | number | boolean | null | CacheKey[];

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

class LockAndCache {
  /**
   * Create a new `LockAndCache`.
   *
   * @param caches Caches to use. Defaults to `tieredCache()`.
   * @param lockClient Redis client to use for locking. Defaults to using
   * `DEFAULT_REDIS_OPTIONS`.
   */
  constructor({
    lockClient = defaultRedisLockClient(),
    cacheClient = defaultRedisCacheClient(),
  } = {});

  /**
   * Shut down this cache manager. No other functions may be called after this.
   */
  close(): void;

  /**
   * Either fetch a value from our cache, or compute it, cache it and return it.
   *
   * @param key The cache key to use.
   * @param options Cache options. `ttl` is in seconds.
   * @param work A function which performs an expensive caculation that we want
   * to cache.
   */
  async get<T>(key: CacheKey, options: GetOptions, work: WorkFn<T>): Promise<T>;

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
  ): WorkFn<T, Args>;
}
```

## Contributing

Please send us your pull requests!
