import test from 'tape-promise/tape'
import redis from 'redis'

import cache from './'

test.onFailure(() => {
  process.exit(1)
})

test('closing', async function (t) {
  let closeCallCount = 0
  let cbCallCount = 0
  let obj = { close () {
    closeCallCount++
  } }
  let cb = async function () {
    cbCallCount++
  }
  await cache.closing(obj, cb)
  t.equal(1, closeCallCount, '1 === closeCallCount')
  t.equal(1, cbCallCount, '1 === cbCallCount')
})

class RefCounterFixture {
  constructor () {
    this.cbCallCount = 0
    this.cleanupCallCount = 0
    this.refcounter = new cache.RefCounter(
      this.cb.bind(this),
      this.cleanup.bind(this),
      0
    )
  }
  async cb () {
    await new Promise(resolve => setTimeout(resolve, 100))
    ++this.cbCallCount
  }
  cleanup () {
    ++this.cleanupCallCount
  }
  call () {
    this.rval = this.refcounter()
    return this
  }
  async asyncCall () {
    this.rval = await this.refcounter()
    return this
  }
}

test('RefCounter constructor', async function (t) {
  t.equal('function', typeof new cache.RefCounter())
})

test('RefCounter constructor does not call cb', async function (t) {
  t.equal(0, new RefCounterFixture().cbCallCount)
})

test('RefCounter constructor does not call cleanup', async function (t) {
  t.equal(0, new RefCounterFixture().cleanupCallCount)
})

test('RefCounter when called calls cb', async function (t) {
  t.equal(1, (await new RefCounterFixture().asyncCall()).cbCallCount)
})

test('RefCounter when called does not call cleanup before timeout', async function (t) {
  const f = new RefCounterFixture().call()
  await new Promise(resolve => setTimeout(resolve, 1))
  t.equal(0, f.cleanupCallCount)
})

test('RefCounter when called calls cleanup after timeout', async function (t) {
  let f = new RefCounterFixture()
  await f.call().rval
  return new Promise(resolve => {
    setTimeout(() => {
      t.equal(1, f.cleanupCallCount)
      resolve()
    }, 200)
  })
})

// things to test
// top level funcs
// cold cache
//  returns val
//  calls work
// warm cache
//  returns val
//  does not call work
// wrap method
//  returns wrapper function
// wrapper function
//  calls cache get
//  cold cache
//    returns val
//    calls wrapped function w args
//  warm cache
//    returns val
//    does not call wrapped func
// LockAndCache class
//  constructor
//   works w various opts permutations
//   set things correctly internally
//  pure function methods should be easy

const KEY = 'test:test_key'

class CacheFixture {
  constructor ({ autoJson = false } = {}) {
    const client = redis.createClient()
    client.flushall()
    client.quit()
    this.cache = new cache.LockAndCache({ autoJson })
    this.workCallCount = 0
  }
  async work () {
    console.debug('WORK')
    this.workCallCount++
    return 'value'
  }
  async get () {
    return this
  }
  async warmed () {
    let work = this.work.bind(this)
    await this.cache.get(KEY, 1, work)
    this.value = await this.cache.get(KEY, 1, work)
    console.debug('warmed cache')
    return this
  }
  close () { this.cache.close() }
}

test('LockAndCache cache get transform undefined', async function (t) {
  await cache.closing(new CacheFixture(), async function (f) {
    t.equal(typeof f.cache._cacheGetTransform('undefined'), 'undefined')
  })
})

test('LockAndCache cache get transform json autoJson false', async function (t) {
  await cache.closing(new CacheFixture(), async function (f) {
    t.deepEqual(f.cache._cacheGetTransform('{"foo": "bar"}'), '{"foo": "bar"}')
  })
})

test('LockAndCache cache get transform json autoJson true', async function (t) {
  await cache.closing(new CacheFixture({ autoJson: true }), async function (f) {
    t.deepEqual(f.cache._cacheGetTransform('{"foo": "bar"}'), { foo: 'bar' })
  })
})

test('_cacheSetTransform undefined', async function (t) {
  await cache.closing(new CacheFixture(), async function (f) {
    t.equal(f.cache._cacheSetTransform(undefined), 'undefined')
  })
})

test('_cacheSetTransform object autojson false', async function (t) {
  const OBJ = { foo: 'bar' }
  await cache.closing(new CacheFixture(), async function (f) {
    t.deepEqual(f.cache._cacheSetTransform(OBJ), OBJ)
  })
})

test('_cacheSetTransform object autojson true', async function (t) {
  const OBJ = { foo: 'bar' }
  await cache.closing(new CacheFixture({ autoJson: true }), async function (f) {
    t.deepEqual(f.cache._cacheSetTransform(OBJ), JSON.stringify(OBJ))
  })
})

test('_cacheGet throws KeyNotFound when key not found', async function (t) {
  await cache.closing(new CacheFixture(), async function (f) {
    await t.rejects(
      f.cache._cacheGet('key that does not exist'),
      cache.KeyNotFoundError
    )
  })
})

test('_cacheGet does not throw when key found', async function (t) {
  await cache.closing(await new CacheFixture().warmed(), async function (f) {
    await f.cache._cacheGet(KEY)
  })
})

test('LockAndCache work called', async function (t) {
  await cache.closing(await new CacheFixture().warmed(), async function (f) {
    t.equal(f.workCallCount, 1)
  })
})

test('LockAndCache value', async function (t) {
  await cache.closing(await new CacheFixture().warmed(), async function (f) {
    t.equal(f.value, 'value')
  })
})

let executionCount = 0
async function double (a) {
  console.debug('excount', ++executionCount, a)
  return a * 2
}

const cachedDouble = cache.wrap(1, double)

let undefExecutionCount = 0
async function undef () {
  undefExecutionCount++
  return undefined
}

const cachedUndefined = cache.wrap(1, undef)

async function cachedStandaloneDouble (a) {
  console.debug('cachedStandaloneDouble', a)
  return cache(['standaloneDouble', a], 1, async function () {
    console.debug('cachedStandaloneDouble work', a)
    executionCount++
    return a * 2
  })
}

test('basic', async function (t) {
  executionCount = 0
  let four = await cachedDouble(2)
  t.equal(four, 4)
  t.equal(executionCount, 1)
  console.debug('get next thing')
  four = await cachedDouble(2)
  console.debug('got next thing')
  t.equal(four, 4)
  t.equal(executionCount, 1)
  console.debug('basic test done')
})

test('parallel', async function (t) {
  executionCount = 0
  let results = await Promise.all([1, 4, 3, 3, 4, 1].map(i => cachedDouble(i)))
  t.deepEqual(results, [2, 8, 6, 6, 8, 2])
  t.equal(executionCount, 3)
})

test('standalone', async function (t) {
  executionCount = 0
  let results = await Promise.all([1, 4, 3, 3, 4, 1].map(i => cachedStandaloneDouble(i)))
  console.debug('standalone got results')
  t.deepEqual(results, [2, 8, 6, 6, 8, 2])
  t.equal(executionCount, 3)
})

test('fail', async function (t) {
  const expectedErr = new Error('test me please')
  try {
    await cache('fail_test', 1, () => Promise.reject(expectedErr))
    t.fail('should not resolve')
  } catch (err) {
    for (let prop of ['name', 'message', 'stack']) {
      t.equal(err[prop], expectedErr[prop], `should propagate rejection error ${prop}`)
    }
  }
})

test('undefined', async function (t) {
  undefExecutionCount = 0
  let un = await cachedUndefined()
  t.equal(un, undefined)
  t.equal(undefExecutionCount, 1)
  un = await cachedUndefined()
  t.equal(un, undefined)
  t.equal(undefExecutionCount, 1)
})
