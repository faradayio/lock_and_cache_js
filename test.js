import test from 'blue-tape'
import cache from './'

let executionCount = 0
async function double (a) {
  executionCount++
  return a * 2
}

const cachedDouble = cache.wrap(1, double)

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
  four = await cachedDouble(2)
  t.equal(four, 4)
  t.equal(executionCount, 1)
})

test('parallel', async function (t) {
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
  let expectedErr = new Error()
  try {
    await cache('fail_test', 1, () => Promise.reject(expectedErr))
    t.fail('should not resolve')
  } catch (err) {
    t.equal(err, expectedErr, 'should propagate rejection error')
  }
})
