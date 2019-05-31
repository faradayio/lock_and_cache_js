const { LockAndCache } = require('./')

// const redis = require('redis')
const cacheManager = require('cache-manager')

const KEY = 'test:test_key'

const cache = new LockAndCache({
  // byReference: true,
  caches: [cacheManager.caching({ store: 'memory', max: 10, ttl: 60 * 60 })]
})

// const client = redis.createClient()
// try {
//   client.flushall()
// } finally {
//   client.quit()
// }

async function work () {
  console.log('work')
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      console.log('promise resolve')
      resolve('AHGLAHGALHGALGH')
    }, 10000)
  })
}

async function main () {
  try {
    console.log('await cache.get')
    await cache.get(KEY, work)
  } finally {
    console.log('close cache')
    cache.close()
  }
}

main().catch(console.log)
