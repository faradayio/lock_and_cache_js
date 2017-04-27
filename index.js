var redis = require('redis')
var Redlock = require('redlock')
var assert = require('assert')

const DEFAULT_REDIS_OPTIONS = {
  retry_strategy (options) {
    return Math.min(options.attempt * 100, 3000)
  }
}

function defaults (opts, defs) {
  let options = {}
  for (let key in defs) {
    options[key] = defs[key]
  }
  for (let key in opts) {
    options[key] = opts[key]
  }
  return options
}

function redisGet (client, key) {
  return new Promise(function lookup (resolve, reject) {
    client.get(key, function onGet (err, value) {
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

function redisSet (client, key, ttl, value) {
  return new Promise(function set (resolve, reject) {
    var storedValue
    if (typeof value === 'undefined') {
      storedValue = 'undefined'
    } else {
      storedValue = JSON.stringify(value)
    }
    client.setex(key, ttl, storedValue, function onSet (err) {
      if (err) {
        reject(err)
      } else {
        resolve(value)
      }
    })
  })
}

function lockAndCache (getLocker, key, ttl, work) {
  key = JSON.stringify(key)

  var locker = getLocker()
  var client = locker[0]
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
    redisGet(client, key)
      .catch(function onErr (err) {
        if (err !== 'key not found') throw err
        return (
          redlock.lock('lock:' + key, 5000)
            .then(function onLock (_lock) {
              extendTimeout = setTimeout(extend, 2500)
              lock = _lock
              return redisGet(client, key)
            })
            .catch(function onErr (err) {
              if (err !== 'key not found') throw err
              return work().then(redisSet.bind(null, client, key, ttl))
            })
        )
      })
      .then(function onValue (_value) {
        value = _value
        return cleanup()
      })
      .then(function onCleanup () {
        return value
      })
      .catch(function (err) {
        return cleanup().then(function throwErr () {
          throw err
        })
      })
  )
}

lockAndCache.configure = function (servers, opts) {
  var refs = 0
  var cleanupTimeout
  var clients
  var redlock

  if (!Array.isArray(servers)) servers = [servers]

  function tryToCleanUp () {
    if (refs === 0 && !cleanupTimeout && clients) {
      cleanupTimeout = setTimeout(function reap () {
        clients.forEach((c) => c.quit())
        redlock = clients = cleanupTimeout = null
      }, process.env.NODE_ENV === 'test' ? 50 : 30000)
    }
  }

  function getLocker () {
    if (cleanupTimeout) {
      clearTimeout(cleanupTimeout)
      cleanupTimeout = null
    }
    refs++

    var unrefd = false
    function unref () {
      if (unrefd) return
      unrefd = true
      refs--
      tryToCleanUp()
    }

    if (!clients) {
      clients = servers.map(function (server) {
        if (!Array.isArray(server)) server = [server]

        if (typeof server[1] === 'object') {
          server = [
            server[0],
            defaults(server[1], DEFAULT_REDIS_OPTIONS)
          ].concat(server.slice(2))
        } else if (typeof server[0] === 'object') {
          server = [
            defaults(server[0], DEFAULT_REDIS_OPTIONS)
          ].concat(server.slice(1))
        } else {
          server = server.concat([DEFAULT_REDIS_OPTIONS])
        }

        return redis.createClient.apply(redis, server)
      })
      redlock = new Redlock(clients, opts)
    }

    return [clients[0], redlock, unref]
  }

  var cache = lockAndCache.bind(null, getLocker)
  cache.wrap = function wrap (name, ttl, work) {
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
      var args = Array.prototype.slice.call(arguments, 0, work.length)
      var key = [name].concat(args)
      return cache(key, ttl, function doWork () {
        return Promise.resolve(work.apply(null, args))
      })
    }
    wrappedFn.displayName = name

    return wrappedFn
  }

  return cache
}

module.exports = lockAndCache.configure(process.env.REDIS_URL, {
  driftFactor: Number(process.env.LOCK_DRIFT_FACTOR) || null,
  retryCount: Number(process.env.LOCK_RETRY_COUNT) || 36000,
  retryDelay: Number(process.env.LOCK_RETRY_DELAY) || 100
})

module.exports.configure = lockAndCache.configure
