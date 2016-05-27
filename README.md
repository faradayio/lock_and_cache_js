# lock_and_cache

Lock and cache using redis!

Most caching libraries don't do locking, meaning that >1 process can be calculating a cached value at the same time. Since you presumably cache things because they cost CPU, database reads, or money, doesn't it make sense to lock while caching?

## Quickstart

```js
const cache = require('lock_and_cache')

// standalone mode
function getStockQuote (symbol) {
  return cache(['stock', symbol], 60, async function () {
    // fetch stock price from remote source, cache for one minute
    // calling this multiple times in parallel will only run it once
  })
}

// wrap mode
const getStockQuote = cache.wrap(60, async function stock (symbol) {
  // fetch stock price from remote source, cache for one minute
  // calling this multiple times in parallel will only run it once
  // the cache key is based on the function name and arguments
})
```

## Install

```console
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

Since the url to your redis server is already in the REDIS_URL environment
variable, no configuration is required.

If, somehow, you forgot to set up your environment variables, you can do so like
this:

```console
REDIS_URL=redis://my-redis-host:6379 node myapp.js
```

If you are trapped in some sort of post-apocalyptic scenario and environment
variables are not available to you at this time, or the times have changed and
environment variables are no longer in vogue, consider using the `configure`
function to connect to an arbitrary redis server.

```js
const lockAndCache = require('lock_and_cache')
const cache = lockAndCache.configure('redis://localhost')
```

## Distributed locking

Distributed locking is supported and uses [redlock](https://www.npmjs.com/package/redlock).

```js
const lockAndCache = require('lock_and_cache')
const cache = lockAndCache.configure([
  'redis://client-1',
  'redis://client-2',
  'redis://client-3'
])
```

All clients you specify will be used for locking, but only the first will be
used for caching.

## API

lockAndCache (*mixed* **key**, *number* **ttl**, *function* **work**)

* returns *Promise*
* **key** can be a number, string, boolean, object, etc. It will be passed to
  [JSON.stringify](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify).
* **ttl** is the time-to-live for the cached value in _seconds_
* **work** is the function that will be executed if the value is not cached. It
can return a promise.

lockAndCache.configure (*mixed* **client(s)**[, *object* **options**])

 * returns a lockAndCache function with the given configuration
 * **client(s)** can be a connection url, a [redis options object](https://www.npmjs.com/package/redis#options-object-properties),
   or an array of connection urls and/or options objects
 * **options** get passed to [redlock](https://www.npmjs.com/package/redlock#configuration)

## Global configuration

The `LOCK_DRIFT_FACTOR`, `LOCK_RETRY_COUNT`, and `LOCK_RETRY_DELAY` environment
variables can be set to configure the global lockAndCache function's locking
behavior. You probably don't need this unless the jobs you are caching are
either very fast or very slow. By default, the global lockAndCache function
will retry every 100ms for one hour using the standard drift factor.

## Contributing

Please send me your pull requests!
