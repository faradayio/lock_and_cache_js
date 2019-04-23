import test from 'tape-promise/tape'
import cache from './'

let executionCount = 0
async function double (a) {
  executionCount++
  return a * 2
}

const cachedDouble = cache.wrap(1, double)

let undefExecutionCount = 0
async function undef () {
  undefExecutionCount++
  return undefined
}

const cachedUndefined = cache.wrap(1, undef)

function cachedStandaloneDouble (a) {
  return cache(['standaloneDouble', a], 1, async function () {
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
  console.debug('parallel test')
  executionCount = 0
  let results = await Promise.all([1, 4, 3, 3, 4, 1].map(cachedDouble))
  t.deepEqual(results, [2, 8, 6, 6, 8, 2])
  t.equal(executionCount, 3)
})

test('standalone', async function (t) {
  executionCount = 0
  let results = await Promise.all([1, 4, 3, 3, 4, 1].map(cachedStandaloneDouble))
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
