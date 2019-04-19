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


const ERROR_TTL = 1

const DEFAULT_REDIS_LOCK_OPTS = {
  retry_strategy (options) {
    return Math.min(options.attempt * 100, 3000)
  }
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


class RefCounter extends Function {
  // thanks to https://stackoverflow.com/a/40878674
  constructor (cb, cleanup, timeout) {
    super('...args', 'return this.__call__(...args)');
    that = this.bind(this)
    that._cb = cb
    that._cleanup = cleanup
    that._timout = timeout
    that._refs = 0
    that._timeoutHandle = null
    return that
  }

  __call__ (...opts) {
    this._ref()
    try {
      this._cb(...opts)
    }
    finally {
      this._unref()
    }
  }

  _ref () {
    clearTimeout(this._timeoutHandle)
    this._timeoutHandle = null
    this._refs++
  }

  _unref () {
    this._refs--
    if (this._refs === 0 ) {
      this._timeoutHandle = setTimeout(this._cleanup, this._timeout)
    }
  }
}

/**
 * Create a mem/redis multi-tier cache; passes opts directly to cache manager
 * which passes directly to node redis client.
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
  return cacheManager.multiCaching([
    cacheManager.caching(Object.assign({}, DEFAULT_MEM_OPTS, memOpts)),
    cacheManager.caching(Object.assign({}, DEFAULT_REDIS_OPTS, redisOpts)),
  ])
}


/**
 * LockAndCache
 *
 * @example
 * LockAndCache()
 * @example
 * LockAndCache(opts)
 * @example
 * LockAndCache({cache, lockServers, driftFactor, retryCount, retryDelay})
 */
class LockAndCache {
  constructor(opts) {
    this.opts = Object.assign({}, opts, {
      cache: tieredCache(),
      lockServers: [process.env.LOCK_URL || process.env.REDIS_URL || 'localhost'],
      cacheServer: (process.env.CACHE_URL || process.env.REDIS_URL || 'localhost'),
      driftFactor: Number(process.env.LOCK_DRIFT_FACTOR) || null,
      retryCount: Number(process.env.LOCK_RETRY_COUNT) || 36000,
      retryDelay: Number(process.env.LOCK_RETRY_DELAY) || 100
    })
    this.unrefd = false;
    this.refs = 0;
    this.cleanupTimeout = undefined;
    this.lockClients = undefined;
    this.cacheClient = undefined;
    this.redlock = undefined;
    this.get = new RefCounter(this._get, this.close);
  }

  _redisGet (key) {
    return new Promise(function lookup (resolve, reject) {
      this.cacheClient.get(key, function onGet (err, value) {
        if (err) {
          reject(err)
        } else if (value === null) {
          reject('key not found')
        } else if (value === 'undefined') {
          resolve(undefined)
        } else {
          resolve(JSON.parse(value))
        }
      })
    })
  }

  _redisSet (key, ttl, value) {
    return new Promise(function set (resolve, reject) {
      var storedValue
      if (typeof value === 'undefined') {
        storedValue = 'undefined'
      } else {
        storedValue = JSON.stringify(value)
      }
      this.cacheClient.set(key, storedValue, {ttl}, function onSet (err) {
        if (err) {
          reject(err)
        } else {
          resolve(value)
        }
      })
    })
  }

  close() {
    this.clients.forEach((c) => c.quit())
  }

  open() {
    let cacheClient;
    let redlock;

    if (!clients) {
      clients = servers.map(function (server) {
        if (!Array.isArray(server)) server = [server]

        if (typeof server[1] === 'object') {
          server = [
            server[0],
            defaults(server[1], DEFAULT_REDIS_OPTS)
          ].concat(server.slice(2))
        } else if (typeof server[0] === 'object') {
          server = [
            defaults(server[0], DEFAULT_REDIS_OPTS)
          ].concat(server.slice(1))
        } else {
          server = server.concat([DEFAULT_REDIS_OPTS])
        }

        return redis.createClient.apply(redis, server)
      })
      redlock = new Redlock(clients, opts)
      if (seperateCacheServer) {
        cacheClient = clients.pop()
      } else {
        cacheClient = clients[0]
      }
    }

    this._cacheClient = cacheClient
    this._redlock = redlock
  }

  wrap (name, ttl, work) {
    if (typeof ttl === 'function') {
      work = ttl
      ttl = name
      name = work.displayName || work.name
    }

    if (!name) {
      // a man needs a name
      throw new Error('cannot do lockAndCache.wrap(work) on an anonymous function')
    }

    assert.equal(typeof name, 'string', 'name should be string')
    assert.equal(typeof ttl, 'number', 'ttl should be number')
    assert.equal(typeof work, 'function', 'work should be function')

    var wrappedFn = function () {
      var args = Array.prototype.slice.call(arguments)
      var key = [name].concat(args)
      return cache(key, ttl, function doWork () {
        return Promise.resolve(work.apply(null, args))
      })
    }
    wrappedFn.displayName = name

    return wrappedFn
  }

  _get (key, ttl, work) {
    key = JSON.stringify(key)

    var locker = getLocker()
    var cacheClient = locker[0]
    var redlock = locker[1]
    var unref = locker[2]

    var lock
    var value
    var done
    var extendTimeout

    function extend () {
      if (lock && !done) {
        lock.extend(5000, function onExtend (err) {
          if (lock && !done) {
            extendTimeout = setTimeout(extend, err ? 500 : 2500)
          }
        })
      }
    }

    function cleanup () {
      done = true
      if (extendTimeout) clearTimeout(extendTimeout)
      unref()
      return lock ? lock.unlock() : Promise.resolve()
    }

    return (
      redisGet(cacheClient, key)
        .catch(function onErr (err) {
          if (err !== 'key not found') throw err
          return (
            redlock.lock('lock:' + key, 5000)
              .then(function onLock (_lock) {
                extendTimeout = setTimeout(extend, 2500)
                lock = _lock
                return redisGet(cacheClient, key)
              })
              .catch(function onLockErr (err) {
                if (err !== 'key not found') throw err
                return work().catch(function onWorkErr (err) {
                  ttl = ERROR_TTL
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
                }).then(function onWorkDone (data) {
                  return redisSet(cacheClient, key, ttl, data)
                })
              })
          )
        })
        .then(function onValue (_value) {
          value = _value
          return cleanup()
        })
        .then(function onCleanup () {
          if (typeof value === 'object' && value !== null && value.__lock_and_cache_error__) {
            if (typeof value.err === 'object') {
              const err = new Error()
              Object.assign(err, value.err)
              throw err
            } else {
              throw new Error(value.err)
            }
          }
          return value
        })
        .catch(function (err) {
          return cleanup().then(function throwErr () {
            throw err
          })
        })
    )
  }
}


module.exports = LockAndCache().lockAndCache
module.exports.LockAndCache = LockAndCache
module.exports.tieredCache = tieredCache
module.exports.closing = closing
