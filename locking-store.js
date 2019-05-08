export const LOCK_TIMEOUT = 5000
export const LOCK_EXTEND_TIMEOUT = 2500
export const LOCK_MAX_EXTENSIONS = 100

function log (...message) {
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

export class LockMaxExtensionsReached extends Error {}

export class ExtendableLock {
  constructor ({
    redlock,
    autoExtend=true,
    maxExtensions=LOCK_MAX_EXTENSIONS,
    extendInterval=LOCK_EXTEND_TIMEOUT
  }) {
    this.redlock = redlock
    this.autoExtend = autoExtend
    this.maxExtensions = maxExtensions
    this.extensionsRemaining = 0
    this.lock = null
    this._autoExtendTimeoutHandle = null
  }

  async _autoExtendTimeout() {
    try {
      await this.extend()
    }
    catch (err) {
      if (err instanceof LockMaxExtensionsReached) {
        return
      }
      throw err
    }
    this._autoExtendTimeoutHandle = setTimeout(
      this._autoExtendTimeout.bind(this),
      LOCK_EXTEND_TIMEOUT
    )
  }

  _clearTimeout() {
    clearTimeout(this._autoExtendTimeoutHandle)
  }

  async lock(...opts) {
    if(this.extensionsRemaining > 0) return;
    this.unlocked = new Promise()
    this.extensionsRemaining = maxExtensions
    this.lock = await this.redlock.lock(...opts)
    this.autoExtend && this._autoExtendTimeout();
  }

  unlock(...opts) {
    this._clearTimeout()
    this.extensionsRemaining = 0
    const lock = this.lock
    this.lock = null
    this.unlocked.resolve()
    return lock.unlock(...opts)
  }

  extend(...opts) {
    if (this.extensionsRemaining == 0) {
      throw new LockMaxExtensionsReached()
    }
    this.extensionsRemaining--
    return this.lock.extend(...opts)
  }
}

export default class LockingStore {
  constructor ({store, redlock, timeout=LOCK_TIMEOUT, extendInterval=LOCK_EXTEND_TIMEOUT}) {
    this.store = store
    this.redlock = redlock
    this.timeout = timeout
    this.extendInterval = extendInterval
    this._locks = new Map()
  }

  async lock (key) {
    let lock = this._locks.get(key);
    if (lock) {
      await lock.unlocked;
    }
    lock = new ExtendableLock({redlock: this.redlock})
    await lock.lock('lock:' + key, LOCK_TIMEOUT)
    this._locks.set(key, lock)
    return lock
  }

  async unlock (key) {
    const lock = this._locks.get(key)
    this._locks.delete(key)
    const r = lock.unlock()
    return r
  }

  async get (key, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = undefined;
    }
    opts = opts || {};
    cb = cb || () => {};
    try {
      let value = await this.store.get(key, opts)
      if (value === null) {
        await this.lock(key)
      }
      try {
        if (value === null) {
          value = await this.store.get(key, opts)
        }
        cb(null, value)
        return value;
      }
      finally {
        if (value !== null) {
          this.unlock(key)
        }
      }
    }
    catch (err) {
      cb(err, null)
      throw err
    }
  }

  async set (key, value, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = undefined;
    }
    opts = opts || {};
    cb = cb || () => {};
    try {
      const v = await this.store.set(key, value, opts)
      cb(null, v)
      return v
    }
    catch (err) {
      cb(err, null)
    }
    finally {
      this.unlock(key)
    }
  }
}
