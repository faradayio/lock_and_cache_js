import test from "tape-promise/tape";
import redis from "redis";
import cacheManager from "cache-manager";

import {
  LockAndCache,
  closing,
  KeyNotFoundError,
  DEFAULT_REDIS_CACHE_OPTS,
  DEFAULT_MEM_CACHE_OPTS,
  LOCK_EXTEND_TIMEOUT,
  Lock,
  AsyncRedis,
} from "../lib";

test.onFailure(() => {
  process.exit(1);
});

test("closing", async function (t) {
  let closeCallCount = 0;
  let cbCallCount = 0;
  let obj = {
    close() {
      closeCallCount++;
    },
  };
  let cb = async function () {
    cbCallCount++;
  };
  await closing(obj, cb);
  t.equal(1, closeCallCount, "1 === closeCallCount");
  t.equal(1, cbCallCount, "1 === cbCallCount");
});

const KEY = "test:test_key";

class CacheFixture {
  flushed: any;
  warmed: any;
  cache: any;
  workCallCount: any;
  cachedDouble: any;
  slowWork: any;
  value: any;

  constructor({
    byReference = false,
    type = undefined,
    caches = undefined,
    warm = undefined,
  } = {}) {
    const client = new AsyncRedis(redis.createClient());
    try {
      this.flushed = client.flushall();
    } finally {
      client.quit();
    }
    this.warmed = warm
      ? this.flushed.then(() => this.warm(warm))
      : Promise.resolve();
    this.cache = new LockAndCache({ byReference, caches });
    this.workCallCount = 0;
    this.cachedDouble = this.cache.wrap(
      async function double(a) {
        console.debug("excount", ++this.workCallCount, a);
        return a * 2;
      }.bind(this)
    );
    this.slowWork = this.cache.wrap(async function slowWork(a) {
      await new Promise((resolve) =>
        setTimeout(resolve, LOCK_EXTEND_TIMEOUT * 3)
      );
      return "slowWork";
    });
  }
  async work(value) {
    // console.debug('WORK')
    this.workCallCount++;
    return value;
  }
  async warm({ key, value } = { key: KEY, value: "value" }) {
    value = key === "undefined" ? undefined : value;
    // console.log(key, value)
    let work = () => this.work(value);
    await this.cache.get(key, 1, work);
    this.value = await this.cache.get(key, 1, work);
    // console.debug('warmed cache')
    return this;
  }
  close() {
    this.cache.close();
  }
}

function cacheFixtureTest({ name, func, fixtureOpts = {} }) {
  test(name, async function (t) {
    await closing(new CacheFixture(fixtureOpts), async function (f) {
      await f.flushed;
      await f.warmed;
      await func(t, f);
    });
  });
}

cacheFixtureTest({
  name: "LockAndCache cache get transform undefined",
  func: async function (t, f) {
    t.equal(typeof f.cache._cacheGetTransform("undefined"), "undefined");
  },
});

cacheFixtureTest({
  name: "LockAndCache cache get transform byReference false",
  func: async function (t, f) {
    const OBJ = { foo: "bar" };
    const expected = { ...OBJ };
    t.deepEqual(f.cache._cacheGetTransform(JSON.stringify(OBJ)), expected);
    t.notEqual(f.cache._cacheGetTransform(JSON.stringify(OBJ)), OBJ);
  },
});

cacheFixtureTest({
  name: "LockAndCache cache get transform byReference true",
  fixtureOpts: { byReference: true },
  func: async function (t, f) {
    const OBJ = { foo: "bar" };
    const expected = { ...OBJ };
    t.deepEqual(f.cache._cacheGetTransform(OBJ), expected);
    t.equal(f.cache._cacheGetTransform(OBJ), OBJ);
  },
});

cacheFixtureTest({
  name: "_cacheSetTransform undefined",
  func: async function (t, f) {
    t.equal(f.cache._cacheSetTransform(undefined), "undefined");
  },
});

cacheFixtureTest({
  name: "_cacheSetTransform object byReference false",
  func: async function (t, f) {
    const OBJ = { foo: "bar" };
    const expected = JSON.stringify(OBJ);
    t.deepEqual(f.cache._cacheSetTransform(OBJ), expected);
    t.notEqual(f.cache._cacheSetTransform(OBJ), OBJ);
  },
});

cacheFixtureTest({
  name: "_cacheSetTransform object byReference true",
  fixtureOpts: { byReference: true },
  func: async function (t, f) {
    const OBJ = { foo: "bar" };
    const expected = { ...OBJ };
    t.deepEqual(f.cache._cacheSetTransform(OBJ), expected);
    t.equal(f.cache._cacheSetTransform(OBJ), OBJ);
  },
});

cacheFixtureTest({
  name: "_cacheGet throws KeyNotFound when key not found",
  func: async function (t, f) {
    await t.rejects(
      f.cache._cacheGet("key that does not exist"),
      KeyNotFoundError
    );
  },
});

cacheFixtureTest({
  name: "_cacheGet does not throw when key found",
  fixtureOpts: { warm: { key: KEY, value: "value" } },
  func: async function (t, f) {
    await f.cache._cacheGet(KEY);
  },
});

cacheFixtureTest({
  name: "LockAndCache work called",
  fixtureOpts: { warm: { key: KEY, value: "value" } },
  func: async function (t, f) {
    t.equal(f.workCallCount, 1);
  },
});

cacheFixtureTest({
  name: "LockAndCache value",
  fixtureOpts: { warm: { key: KEY, value: "value" } },
  func: async function (t, f) {
    t.equal(f.value, "value");
  },
});

const stores = {
  redis: DEFAULT_REDIS_CACHE_OPTS,
  memory: DEFAULT_MEM_CACHE_OPTS,
};

class TestClass {}

[true, false].forEach((byReference) => {
  ["memory", "redis"].forEach((store) => {
    [
      ["int", 1],
      ["float", 1.0],
      ["string", "value"],
      ["undefined", undefined],
      ["null", null],
      ["object", { foo: "bar" }],
      ["array", ["foobar"]],
      [
        "TestClass",
        new TestClass(),
        (t, ac) => {
          if (byReference && store === "memory") {
            t.equal(
              ac instanceof TestClass,
              true,
              `${ac} not instance of TestClass`
            );
          } else {
            t.equal(
              ac instanceof TestClass,
              false,
              `${ac} instance of TestClass`
            );
          }
        },
      ],
    ].forEach(([type, value, assertion]: [any, any, any]) => {
      cacheFixtureTest({
        name: `type: ${type}, byReference: ${byReference}, store: ${store}`,
        fixtureOpts: {
          byReference,
          caches: [cacheManager.caching(stores[store])],
          warm: { key: type, value },
        },
        func: async function (t, f) {
          // console.log(type, value);
          // console.log(f.value, value)
          t.deepEqual(f.value, value);
          if (assertion) {
            assertion(t, f.value);
          }
        },
      });
    });
  });
});

cacheFixtureTest({
  name: "parallel",
  func: async function (t, f) {
    let results = await Promise.all(
      [1, 4, 3, 3, 4, 1].map((i) => f.cachedDouble(i))
    );
    t.deepEqual(results, [2, 8, 6, 6, 8, 2]);
    t.equal(f.workCallCount, 3);
  },
});

cacheFixtureTest({
  name: "fail",
  func: async function (t, f) {
    const expectedErr = new TypeError("test me please");
    try {
      await f.cache.get("fail_test", 1, () => Promise.reject(expectedErr));
      t.fail("should not resolve");
    } catch (err) {
      for (let prop of ["name", "message", "stack"]) {
        t.equal(
          err[prop],
          expectedErr[prop],
          `should propagate rejection error ${prop}`
        );
      }
    }
  },
});

cacheFixtureTest({
  name: "extend error",
  func: async function (t, f) {
    const err = new Error("extend error test");
    const mocklock = {
      async lockRetryExtending() {
        return {
          async unlock() {},
          async extend() {
            throw err;
          },
        };
      },
    };
    f.cache._lockManager = mocklock;
    try {
      await f.cache.get("extendtest", async function work() {
        return "extendtest";
      });
    } catch (_err) {
      t.equal(_err, err);
      return;
    }
    throw new Error(`expected to catch ${err}`);
  },
  // TODO ensure cache not set
});

cacheFixtureTest({
  name: "slowWork",
  func: async function (t, f) {
    await f.slowWork();
  },
});

test("missed extend deadline", async function (t) {
  const lock = new Lock();
  lock.extend = async function mockExtend() {
    await new Promise((resolve) =>
      setTimeout(resolve, LOCK_EXTEND_TIMEOUT * 1.5)
    );
  };
  // console.log('start extend loop')
  lock.extendForever();
  // console.log('wait for loop to run a few times')
  await new Promise((resolve) =>
    setTimeout(resolve, LOCK_EXTEND_TIMEOUT * 3.5)
  );
  // console.log('set done')
  lock.done = true;
  // console.log('await extension')
  await lock.extension;
  t.equal(lock.extendMissedDeadlines, 3);
  // TODO ensure cache not set
});
