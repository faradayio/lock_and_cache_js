import test from 'tape-promise/tape'
import redis from 'redis'

import {
  LockAndCache,
  closing,
  KeyNotFoundError,
  DEFAULT_REDIS_CACHE_OPTS,
  DEFAULT_MEM_CACHE_OPTS
} from './'

const cacheManager = require('cache-manager')

// test.onFailure(() => {
//   process.exit(1)
// })

test('closing', async function (t) {
  let closeCallCount = 0
  let cbCallCount = 0
  let obj = { close () {
    closeCallCount++
  } }
  let cb = async function () {
    cbCallCount++
  }
  await closing(obj, cb)
  t.equal(1, closeCallCount, '1 === closeCallCount')
  t.equal(1, cbCallCount, '1 === cbCallCount')
})

const KEY = 'test:test_key'

class CacheFixture {
  constructor ({
    byReference = false,
    type = undefined,
    caches = undefined
  } = {}) {
    const client = redis.createClient()
    try {
      client.flushall()
    } finally {
      client.quit()
    }
    this.cache = new LockAndCache({ byReference, caches })
    this.workCallCount = 0
    this.cachedDouble = this.cache.wrap(
      async function double (a) {
        console.debug('excount', ++this.workCallCount, a)
        return a * 2
      }.bind(this)
    )
  }
  async work (value) {
    // console.debug('WORK')
    this.workCallCount++
    return value
  }
  async warmed ({ key, value } = { key: KEY, value: 'value' }) {
    value = key === 'undefined' ? undefined : value
    // console.log(key, value)
    let work = () => this.work(value)
    await this.cache.get(key, 1, work)
    this.value = await this.cache.get(key, 1, work)
    // console.debug('warmed cache')
    return this
  }
  close () { this.cache.close() }
}

test('LockAndCache cache get transform undefined', async function (t) {
  await closing(new CacheFixture(), async function (f) {
    t.equal(typeof f.cache._cacheGetTransform('undefined'), 'undefined')
  })
})

test('LockAndCache cache get transform byReference false', async function (t) {
  const OBJ = { foo: 'bar' }
  const expected = { ...OBJ }
  await closing(new CacheFixture(), async function (f) {
    t.deepEqual(f.cache._cacheGetTransform(JSON.stringify(OBJ)), expected)
    t.notEqual(f.cache._cacheGetTransform(JSON.stringify(OBJ)), OBJ)
  })
})

test('LockAndCache cache get transform byReference true', async function (t) {
  const OBJ = { foo: 'bar' }
  const expected = { ...OBJ }
  await closing(new CacheFixture({ byReference: true }), async function (f) {
    t.deepEqual(f.cache._cacheGetTransform(OBJ), expected)
    t.equal(f.cache._cacheGetTransform(OBJ), OBJ)
  })
})

test('_cacheSetTransform undefined', async function (t) {
  await closing(new CacheFixture(), async function (f) {
    t.equal(f.cache._cacheSetTransform(undefined), 'undefined')
  })
})

test('_cacheSetTransform object byReference false', async function (t) {
  const OBJ = { foo: 'bar' }
  const expected = JSON.stringify(OBJ)
  await closing(new CacheFixture(), async function (f) {
    t.deepEqual(f.cache._cacheSetTransform(OBJ), expected)
    t.notEqual(f.cache._cacheSetTransform(OBJ), OBJ)
  })
})

test('_cacheSetTransform object byReference true', async function (t) {
  const OBJ = { foo: 'bar' }
  const expected = { ...OBJ }
  await closing(new CacheFixture({ byReference: true }), async function (f) {
    t.deepEqual(f.cache._cacheSetTransform(OBJ), expected)
    t.equal(f.cache._cacheSetTransform(OBJ), OBJ)
  })
})

test('_cacheGet throws KeyNotFound when key not found', async function (t) {
  await closing(new CacheFixture(), async function (f) {
    await t.rejects(
      f.cache._cacheGet('key that does not exist'),
      KeyNotFoundError
    )
  })
})

test('_cacheGet does not throw when key found', async function (t) {
  await closing(await new CacheFixture().warmed(), async function (f) {
    await f.cache._cacheGet(KEY)
  })
})

test('LockAndCache work called', async function (t) {
  await closing(await new CacheFixture().warmed(), async function (f) {
    t.equal(f.workCallCount, 1)
  })
})

test('LockAndCache value', async function (t) {
  await closing(await new CacheFixture().warmed(), async function (f) {
    t.equal(f.value, 'value')
  })
})

const stores = {
  redis: DEFAULT_REDIS_CACHE_OPTS,
  memory: DEFAULT_MEM_CACHE_OPTS
}

class TestClass {}

[true, false].forEach(byReference => {
  ['memory', 'redis'].forEach(store => {
    [
      ['int', 1],
      ['float', 1.0],
      ['string', 'value'],
      ['undefined', undefined],
      ['null', null],
      ['object', { foo: 'bar' }],
      ['array', ['foobar']],
      ['TestClass', new TestClass(), (t, ac) => {
        if (byReference && store === 'memory') {
          t.equal(
            (ac instanceof TestClass), true, `${ac} not instance of TestClass`)
        } else {
          t.equal(
            (ac instanceof TestClass), false, `${ac} instance of TestClass`)
        }
      }]
    ].forEach(([type, value, assertion]) => {
      test(`type: ${type}, byReference: ${byReference}, store: ${store}`, async function (t) {
        // console.log(type, value);
        await closing(
          await new CacheFixture({
            byReference,
            caches: [cacheManager.caching(stores[store])]
          }).warmed({ key: type, value }),
          async function (f) {
            // console.log(f.value, value)
            t.deepEqual(f.value, value)
            if (assertion) {
              assertion(t, f.value)
            }
          }
        )
      })
    })
  })
})

test('parallel', async function (t) {
  await closing(new CacheFixture(), async function (f) {
    let results = await Promise.all([1, 4, 3, 3, 4, 1].map(i => f.cachedDouble(i)))
    t.deepEqual(results, [2, 8, 6, 6, 8, 2])
    t.equal(f.workCallCount, 3)
  })
})

test('fail', async function (t) {
  await closing(new CacheFixture(), async function (f) {
    const expectedErr = new TypeError('test me please')
    try {
      await f.cache.get('fail_test', 1, () => Promise.reject(expectedErr))
      t.fail('should not resolve')
    } catch (err) {
      for (let prop of ['name', 'message', 'stack']) {
        t.equal(err[prop], expectedErr[prop], `should propagate rejection error ${prop}`)
      }
    }
  })
})

test('extend error', async function (t) {
  const err = new Error('extend error test')
  await closing(new CacheFixture(), async function (f) {
    const mocklock = {
      async lock () {
        return {
          async unlock () {},
          async extend () {
            throw err
          }
        }
      }
    }
    f.cache._redlock = mocklock
    try {
      await f.cache.get('extendtest', async function work () {
        return 'extendtest'
      })
    } catch (_err) {
      t.equal(_err, err)
      return
    }
    throw new Error(`expected to catch ${err}`)
  })
  // TODO ensure cache not set
})
