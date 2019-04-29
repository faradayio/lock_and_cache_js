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
 * let square = cache.wrap(async function foofunc (x) {return x*x})
 * const customCache = lock_and_cache.LockAndCache({opts})
 * let foo = customCache.get('foo', ()=>'bar')
 */

var redis = require('redis')
var Redlock = require('redlock')
var cacheManager = require('cache-manager')
var redisStore = require('cache-manager-redis-store')

import { inspect } from 'util'

export default function log (...message) {
  if (process.env.NODE_ENV === 'test' && !process.env.DEBUG) return
  message = [new Date(), ...message]
  console.log(...message.map((m) => {
    if (typeof m === 'string') return m
    if (m instanceof Error) return m.stack
    if (m instanceof Date) return m.toLocaleString()
    return inspect(m, { colors: Boolean(process.stdout.isTTY) })
  }))
}

log.debug = function logDebug (...message) {
  if (process.env.NODE_ENV !== 'debug') return
  log(...message)
}

const LOCK_TIMEOUT = 5000
const LOCK_EXTEND_TIMEOUT = 2500
const REDIS_CONN_IDLE_TIMEOUT = ['test', 'debug'].includes(process.env.NODE_ENV) ? 500 : 30000

const ERROR_TTL = 1

const DEFAULT_REDIS_LOCK_OPTS = {
  retry_strategy (options) {
    return Math.min(options.attempt * 100, 3000)
  },
  url: (process.env.LOCK_URL || process.env.REDIS_URL || '//localhost:6379')
}

const DEFAULT_REDLOCK_OPTS = (
  process.env.NODE_ENV === 'test' ? {
    driftFactor: Number(process.env.LOCK_DRIFT_FACTOR) || null,
    retryCount: Number(process.env.LOCK_RETRY_COUNT) || 36000,
    retryDelay: Number(process.env.LOCK_RETRY_DELAY) || 100
  } : {
    driftFactor: Number(process.env.LOCK_DRIFT_FACTOR) || null,
    retryCount: Number(process.env.LOCK_RETRY_COUNT) || 36000,
    retryDelay: Number(process.env.LOCK_RETRY_DELAY) || 100
  }
)

const DEFAULT_MEM_CACHE_OPTS = {
  store: 'memory',
  max: 10,
  ttl: 30
}

const DEFAULT_REDIS_CACHE_OPTS = {
  store: redisStore,
  url: (process.env.CACHE_URL || process.env.REDIS_URL || '//localhost:6379'),
  ttl: 600
}

/**
 * runs cb() then calls obj.close()
 *
 * @example
 * closing(LockAndCache(), cache => console.log(cache.get('key', ()=>{return 'value'})))
 */
async function closing (obj, cb) {
  try {
    return await cb(obj)
  } finally {
    obj.close()
  }
}

/**
 * Count references to a resources and call a cleanup function after refs drop
 * to zero and a timeout expires.
 */
class RefCounter extends Function {
  // thanks to https://stackoverflow.com/a/40878674
  constructor (cb, cleanup, timeout) {
    super('...args', 'return this.__call__(...args)')
    const that = this.bind(this)
    this._cb = cb
    this._cleanup = cleanup
    this._timeout = timeout
    this._refs = 0
    this._timeoutHandle = null
    log.debug('refcounter timeout', timeout)
    return that
  }

  async __call__ (...opts) {
    log.debug('RefCounter called')
    this._ref()
    try {
      log.debug('calling cb')
      return await this._cb(...opts)
    } finally {
      this._unref()
    }
  }

  _ref () {
    clearTimeout(this._timeoutHandle)
    this._timeoutHandle = null
    this._refs++
    log.debug('refs', this._refs)
  }

  _unref () {
    this._refs--
    log.debug('refs', this._refs)
    if (this._refs === 0) {
      log.debug('set cleanup timeout')
      this._timeoutHandle = setTimeout(() => {
        log.debug('cleaning up')
        this._cleanup()
      }, this._timeout)
    }
  }
}

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
function tieredCache (memOpts, redisOpts) {
  return [
    cacheManager.caching(Object.assign({}, DEFAULT_MEM_CACHE_OPTS, memOpts)),
    cacheManager.caching(Object.assign({}, DEFAULT_REDIS_CACHE_OPTS, redisOpts))
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
 * LockAndCache({caches, lockClients, lockOpts})
 * @example
 * const cache = LockAndCache()
 * try {
 *   const val = cache.get('key', async function () { return 'value' })
 * } finally {
 *   cache.close()
 * }
 */
class LockAndCache {
  constructor (opts) {
    const {
      caches = tieredCache(),
      lockClients = [redis.createClient(DEFAULT_REDIS_LOCK_OPTS)],
      lockOpts = DEFAULT_REDLOCK_OPTS
    } = opts || {}
    this._lockClients = lockClients
    this._redlock = new Redlock(lockClients, lockOpts)
    this._cacheClients = (
      caches.map(cache => cache.store.getClient && cache.store.getClient())
        .filter(cache => !!cache)
    )
    this._cache = cacheManager.multiCaching(caches)
    // this.get = this._get
    this.get = new RefCounter(this._get.bind(this), this.close.bind(this), REDIS_CONN_IDLE_TIMEOUT)
    log.debug('conn timeout', REDIS_CONN_IDLE_TIMEOUT)
    log.debug('New cache', opts)
  }

  _cacheGetTransform (value) {
    if (value === 'undefined') return undefined
    try {
      return JSON.parse(value)
    } catch (err) {
      console.error(err, value)
      throw err
    }
  }

  _stringifyKey (key) {
    return typeof key === 'string' ? key : JSON.stringify(key)
  }

  async _cacheGet (key) {
    key = this._stringifyKey(key)
    let value = await this._cache.get(key)
    if (value === null || typeof value === 'undefined') {
      throw new KeyNotFoundError(key)
    }
    value = this._cacheGetTransform(value)
    log.debug('got', value, 'for', key)
    return value
  }

  _cacheSetTransform (value) {
    if (typeof value === 'undefined') return 'undefined'
    return JSON.stringify(value)
  }

  async _cacheSet (key, value, ttl) {
    key = this._stringifyKey(key)
    let v = await this._cache.set(key, this._cacheSetTransform(value), {
      ttl
    })
    log.debug('set', value, 'for', key)
    return v
  }

  close () {
    log.debug('closing connections', [...this._lockClients, ...this._cacheClients].length);
    [...this._lockClients, ...this._cacheClients].forEach(c => c.quit())
  }

  del (...opts) {
    return this._cache.del(...opts)
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

  async _get (key, ttl, work) {
    let value, extendTimeoutHandle
    key = this._stringifyKey(key)

    log.debug('get', key)

    if (typeof work === 'undefined') {
      work = ttl
      ttl = undefined
    }

    try {
      return await this._cacheGet(key)
    } catch (err) {
      if (!(err instanceof KeyNotFoundError)) throw err
    }

    const lock = await this._redlock.lock('lock:' + key, LOCK_TIMEOUT)
    log.debug('locked', key)

    try {
      let extend = () => {
        lock.extend(LOCK_TIMEOUT)
        extendTimeoutHandle = setTimeout(extend, LOCK_EXTEND_TIMEOUT)
      }
      extend()
      try {
        return await this._cacheGet(key)
      } catch (err) {
        if (!(err instanceof KeyNotFoundError)) throw err
      }
      try {
        log.debug('calling work to compute value')
        value = await work()
        return value
      } catch (err) {
        ttl = ERROR_TTL
        value = this._errorFactory(err)
        if (typeof value === 'object' && value !== null && value.__lock_and_cache_error__) {
          if (typeof value.err === 'object') {
            const err = new Error()
            Object.assign(err, value.err)
            throw err
          } else {
            throw new Error(value.err)
          }
        }
      } finally {
        // TODO does this really need to await? We could probably ignore the
        // result
        await this._cacheSet(key, value, ttl)
      }
    } finally {
      clearTimeout(extendTimeoutHandle)
      lock.unlock()
    }
  }

  /**
   * wraps a function in a locking cache
   * @param  {string|number|function} name if 3 params, ttl if 2 params, work if 1 param
   * @param  {number|function} ttl  if 3 params, work if 2 params
   * @param  {function} work if 3 params
   * @return {function}      wrapped function
   */
  wrap (...opts) {
    let name, ttl, work
    if (opts.length === 3) {
      [name, ttl, work] = opts
    } else if (opts.length === 2) {
      [ttl, work] = opts
    } else if (opts.length === 1) {
      [work] = opts
    } else {
      throw new TypeError('wrap requires 1, 2, or 3 arguments')
    }

    if (typeof name !== 'string') {
      name = work.displayName || work.name
    }

    log.debug('wrap', name)

    if (!name) {
      throw new TypeError('lockAndCache.wrap(work) requires named function')
    }

    if (typeof name !== 'string') throw new TypeError('name must be a string')
    if (typeof work !== 'function') throw new TypeError('work must be a function')

    var wrappedFn = async function (...args) {
      log.debug('call wrapped', name, ...args)
      var key = [name].concat(args)
      return this.get(key, ttl, async function doWork () {
        return work(...args)
      })
    }.bind(this)
    wrappedFn.displayName = name

    return wrappedFn
  }
}

const DEFAULT_CACHE = new LockAndCache()

module.exports = DEFAULT_CACHE.get.bind(DEFAULT_CACHE)
module.exports.close = DEFAULT_CACHE.close.bind(DEFAULT_CACHE)
module.exports.wrap = DEFAULT_CACHE.wrap.bind(DEFAULT_CACHE)
module.exports.LockAndCache = LockAndCache
module.exports.RefCounter = RefCounter
module.exports.tieredCache = tieredCache
module.exports.closing = closing
module.exports.DEFAULT_MEM_CACHE_OPTS = DEFAULT_MEM_CACHE_OPTS
module.exports.DEFAULT_REDIS_CACHE_OPTS = DEFAULT_REDIS_CACHE_OPTS
module.exports.DEFAULT_REDIS_LOCK_OPTS = DEFAULT_REDIS_LOCK_OPTS
module.exports.KeyNotFoundError = KeyNotFoundError
