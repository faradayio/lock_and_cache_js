/**
 * Lock and cache using redis, memory, and more!
 * @example
 * const cache = require('lock_and_cache')
 * let square = x => cache(x, x => x*x)
 * @example
 * const cache = require('lock_and_cache')
 * let square = cache.wrap(x=>x*x)
 * @example
 * const lock_and_cache = require('lock_and_cache')
 * let cache = lock_and_cache.LockAndCache()
 * let square = cache.wrap(x=>x*x)
 * let foo = cache.get('foo', ()=>'bar')
 */

var redis = require('redis')
var Redlock = require('redlock')
var assert = require('assert')
var cacheManager = require('cache-manager')
var redisStore = require('cache-manager-redis-store');

const LOCK_TIMEOUT = 5000
const LOCK_EXTEND_TIMEOUT = 2500

const ERROR_TTL = 1

const DEFAULT_REDIS_LOCK_OPTS = {
  retry_strategy (options) {
    return Math.min(options.attempt * 100, 3000)
  },
  url: (process.env.LOCK_URL || process.env.REDIS_URL),
}

const DEFAULT_REDLOCK_OPTS = {
  driftFactor: Number(process.env.LOCK_DRIFT_FACTOR) || null,
  retryCount: Number(process.env.LOCK_RETRY_COUNT) || 36000,
  retryDelay: Number(process.env.LOCK_RETRY_DELAY) || 100,
}

const DEFAULT_MEM_CACHE_OPTS = {
  store: 'memory',
  max: 10,
  ttl: 30
}

const DEFAULT_REDIS_CACHE_OPTS = {
  store: redisStore,
  url: (process.env.CACHE_URL || process.env.REDIS_URL),
  ttl: 600
}


function defaults (opts, defs) {
  return Object.assign({}, opts, defs);
}


/**
 * runs cb() then calls obj.close()
 *
 * @example
 * closing(LockAndCache(), cache => console.log(cache.get('key', (val)=>{...})))
 */
function closing (obj, cb) {
  try {
    cb(obj)
  }
  finally {
    obj.close()
  }
}


// Currently unused; but might still need it if explicit closing is hard
// class RefCounter extends Function {
//   // thanks to https://stackoverflow.com/a/40878674
//   constructor (cb, cleanup, timeout) {
//     super('...args', 'return this.__call__(...args)');
//     that = this.bind(this)
//     that._cb = cb
//     that._cleanup = cleanup
//     that._timout = timeout
//     that._refs = 0
//     that._timeoutHandle = null
//     return that
//   }
//
//   __call__ (...opts) {
//     this._ref()
//     try {
//       this._cb(...opts)
//     }
//     finally {
//       this._unref()
//     }
//   }
//
//   _ref () {
//     clearTimeout(this._timeoutHandle)
//     this._timeoutHandle = null
//     this._refs++
//   }
//
//   _unref () {
//     this._refs--
//     if (this._refs === 0 ) {
//       this._timeoutHandle = setTimeout(this._cleanup, this._timeout)
//     }
//   }
// }

/**
 * Create an array of mem/redis caches suitable for making a multi-tier cache;
 * passes opts directly to cache manager which passes directly to node redis
 * client.
 *
 * An attempt to provide useful defaults is made. These are provided by the
 * DEFAULT_MEM_CACHE_OPTS and DEFAULT_REDIS_CACHE_OPTS objects. User opts
 * override. Theoretically you could override the stores even.
 *
 * See also:
 *
 * - https://github.com/BryanDonovan/node-cache-manager
 * - https://github.com/dabroek/node-cache-manager-redis-store
 * - https://github.com/NodeRedis/node_redis
 *
 * @example
 * tieredCache()
 * @example
 * tieredCache({max: 20, ttl: 60}, {ttl: 1200})
 */
function tieredCache(memOpts, redisOpts) {
  return [
    cacheManager.caching(Object.assign({}, DEFAULT_MEM_CACHE_OPTS, memOpts)),
    cacheManager.caching(Object.assign({}, DEFAULT_REDIS_CACHE_OPTS, redisOpts)),
  ]
}


class KeyNotFoundError extends Error {}

/**
 * LockAndCache
 *
 * @example
 * LockAndCache()
 * @example
 * LockAndCache(opts)
 * @example
 * LockAndCache({cache, lockServers, driftFactor, retryCount, retryDelay})
 * @example
 * const cache = LockAndCache()
 * try { ... } finally { cache.close() }
 */
class LockAndCache {
  constructor(opts) {
    let driftFactor, retryCount, retryDelay
    const {
      caches = tieredCache(),
      lockClients = [redis.createClient(DEFAULT_REDIS_LOCK_OPTS)],
      lockOpts: {...lockOpts},
    } = opts || {};
    this._lockClients = lockClients
    this._redlock = new Redlock(lockClients, {
      ...lockOpts,
      driftFactor,
      retryCount,
      retryDelay,
    })
    this._cacheClients = (
      caches.map(cache => cache.store.getClient && cache.store.getClient())
        .filter(cache => !!cache)
    )
    this._cache = cacheManager.multiCaching(caches);
    // Uncomment to use refcounting finalization
    // this.get = new RefCounter(this._get, this.close);
    // this._cleanupTimeout = undefined;
  }

  _redisGetTransform (value) {
    if (value === null) throw new KeyNotFoundError(key)
    else if (value === 'undefined') return undefined
    return JSON.parse(value)
  }

  async _redisGet (key) {
    return await this._redisGetTransform(this._cache.get(key))
  }

  _redisSetTransform (value) {
    if (typeof value === 'undefined') return 'undefined'
    return JSON.stringify(value)
  }

  async _redisSet (key, value, ttl) {
      return await this._cache.set(key, this._redisSetTransform(value), {ttl})
  }

  close() {
    [...this._lockClients, ...this._cacheClients].forEach((c) => c.quit())
  }

  // open() {
  //   let cacheClient;
  //   let redlock;
  //
  //   if (!clients) {
  //     clients = servers.map(function (server) {
  //       if (!Array.isArray(server)) server = [server]
  //
  //       if (typeof server[1] === 'object') {
  //         server = [
  //           server[0],
  //           defaults(server[1], DEFAULT_REDIS_OPTS)
  //         ].concat(server.slice(2))
  //       } else if (typeof server[0] === 'object') {
  //         server = [
  //           defaults(server[0], DEFAULT_REDIS_OPTS)
  //         ].concat(server.slice(1))
  //       } else {
  //         server = server.concat([DEFAULT_REDIS_OPTS])
  //       }
  //
  //       return redis.createClient.apply(redis, server)
  //     })
  //     redlock = new Redlock(clients, opts)
  //     if (seperateCacheServer) {
  //       cacheClient = clients.pop()
  //     } else {
  //       cacheClient = clients[0]
  //     }
  //   }
  //
  //   this._cacheClient = cacheClient
  //   this._redlock = redlock
  // }

  wrap (name, ttl, work) {
    if (typeof ttl === 'function') {
      work = ttl
      ttl = undefined;
      if (typeof name !== 'string') {
        name = work.displayName || work.name
      }
    }

    if (!name) {
      // a man needs a name
      throw new Error('cannot do lockAndCache.wrap(work) on an anonymous function')
    }

    assert.equal(typeof name, 'string', 'name should be string')
    if (typeof ttl !== 'undefined') console.warn('ttl is ignored')
    assert.equal(typeof work, 'function', 'work should be function')

    var wrappedFn = () => {
      var args = Array.prototype.slice.call(arguments)
      var key = [name].concat(args)
      return this.get(key, ttl, function doWork () {
        return Promise.resolve(work.apply(null, args))
      })
    }
    wrappedFn.displayName = name

    return wrappedFn
  }

  _errorFactory (err) {
    let serializedError
    if (err instanceof Error) {
      serializedError = {}
      if (err.name) serializedError.name = err.name
      if (err.message) serializedError.message = err.message
      if (err.stack) serializedError.stack = err.stack
      Object.assign(serializedError, err) // retain custom properties
    } else {
      serializedError = String(err)
    }
    return {
      __lock_and_cache_error__: true,
      err: serializedError
    }
  }

  async get (key, ttl, work) {
    let value, extendTimeoutHandle

    key = JSON.stringify(key)

    if (typeof work === 'undefined') {
      work = ttl
      ttl = undefined
    }

    try {
      return await this._redisGet(key)
    }
    catch (err) {
      if (typeof err !== 'KeyNotFoundError') throw err
    }

    const lock = await redlock.lock('lock:' + key, LOCK_TIMEOUT)

    try {
      let extend = () => {
        lock.extend(LOCK_TIMEOUT)
        extendTimeoutHandle = setTimeout(extend, LOCK_EXTEND_TIMEOUT)
      }
      extend()
      try {
        return await this._redisGet(key)
      }
      catch (err) {
        if (typeof err !== 'KeyNotFoundError') throw err
      }
      try {
        value = await work()
      }
      catch (err) {
        ttl = ERROR_TTL
        value = this._errorFactory(err)
      }
      this._redisSet(key, value, ttl)
    }
    finally {
      clearTimeout(extendTimeoutHandle)
      lock.unlock()
      if (typeof value === 'object' && value !== null && value.__lock_and_cache_error__) {
        if (typeof value.err === 'object') {
          const err = new Error()
          Object.assign(err, value.err)
          throw err
        } else {
          throw new Error(value.err)
        }
      }
    }
  }
}

const default_cache = new LockAndCache()

module.exports = default_cache.get
module.exports.wrap = default_cache.wrap.bind(default_cache)
module.exports.LockAndCache = LockAndCache
module.exports.tieredCache = tieredCache
module.exports.closing = closing
module.exports.DEFAULT_MEM_CACHE_OPTS = DEFAULT_MEM_CACHE_OPTS
module.exports.DEFAULT_REDIS_CACHE_OPTS = DEFAULT_REDIS_CACHE_OPTS
module.exports.DEFAULT_REDIS_LOCK_OPTS = DEFAULT_REDIS_LOCK_OPTS
module.exports.KeyNotFoundError = KeyNotFoundError
