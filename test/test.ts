import assert from "assert";

import { LockAndCache } from "../lib";
import { serializeKey } from "../lib/serialization";

describe("cache", () => {
  const cache = new LockAndCache();

  let executionCount = 0;
  async function double(a: number) {
    executionCount++;
    return a * 2;
  }

  beforeEach(() => {
    executionCount = 0;
  });

  // Close the cache so our tests quit.
  after(async () => cache.close());

  describe("cache.wrap(f)", () => {
    const cachedDouble = cache.wrap({ ttl: 3 }, double);

    it("should cache the first call to f", async () => {
      let four = await cachedDouble(2);
      assert.strictEqual(four, 4);
      assert.strictEqual(executionCount, 1);
      four = await cachedDouble(2);
      assert.strictEqual(four, 4);
      assert.strictEqual(executionCount, 1);
    });

    it("should cache parallel invocations correctly", async () => {
      const results = await Promise.all(
        [1, 4, 3, 3, 4, 1].map((d) => cachedDouble(d))
      );
      assert.deepStrictEqual(results, [2, 8, 6, 6, 8, 2]);
      assert.strictEqual(executionCount, 3);
    });

    it("should cache across multiple caches", async () => {
      // We want to trigger the "recache in RAM" logic, which can only happen
      // with two caches.
      const cache2 = new LockAndCache();
      try {
        const cachedDouble2 = cache2.wrap({ ttl: 3 }, double);
        const results = await Promise.all([
          ...[10, 20, 20, 10].map((d) => cachedDouble(d)),
          ...[10, 20, 20, 10].map((d) => cachedDouble2(d)),
        ]);
        assert.deepStrictEqual(results, [20, 40, 40, 20, 20, 40, 40, 20]);
        assert.strictEqual(executionCount, 2);
      } finally {
        cache2.close();
      }
    });

    it("should cache `undefined`", async () => {
      let undefExecutionCount = 0;
      async function undef() {
        undefExecutionCount++;
        return undefined;
      }

      const cachedUndefined = cache.wrap({ ttl: 1 }, undef);

      undefExecutionCount = 0;
      let un = await cachedUndefined();
      assert.strictEqual(un, undefined);
      assert.strictEqual(undefExecutionCount, 1);
      un = await cachedUndefined();
      assert.strictEqual(un, undefined);
      assert.strictEqual(undefExecutionCount, 1);
    });
  });

  describe("cache.get", () => {
    function cachedStandaloneDouble(a: number) {
      return cache.get(["standaloneDouble", a], { ttl: 1 }, async () => {
        executionCount++;
        return a * 2;
      });
    }

    it("should cache parallel invocations correctly", async () => {
      const results = await Promise.all(
        [1, 4, 3, 3, 4, 1].map(cachedStandaloneDouble)
      );
      assert.deepStrictEqual(results, [2, 8, 6, 6, 8, 2]);
      assert.strictEqual(executionCount, 3);
    });

    it("should support records as keys", async () => {
      await cache.get(["record", { a: 1, b: 2 }], { ttl: 1 }, async () =>
        double(1)
      );
      await cache.get(["record", { b: 2, a: 1 }], { ttl: 1 }, async () =>
        double(1)
      );
      assert.strictEqual(executionCount, 1);
    });

    it("should cache errors correctly", async () => {
      const expectedErr = new Error("test me please");
      try {
        await cache.get("fail_test", { ttl: 1 }, () =>
          Promise.reject(expectedErr)
        );
        throw new Error("should not resolve");
      } catch (err) {
        assert.strictEqual(
          err.name,
          expectedErr.name,
          "should propagate error name"
        );
        assert.strictEqual(
          err.message,
          expectedErr.message,
          "should propagate error message"
        );
        assert.strictEqual(
          err.stack,
          expectedErr.stack,
          "should propagate error stack"
        );
      }
    });

    it("should cache circular errors correctly", async () => {
      class CircularError extends Error {
        private circular: CircularError;
        constructor(message: string) {
          super(message);
          this.circular = this;
        }
      }

      try {
        await cache.get("fail_circular_test", { ttl: 1 }, () =>
          Promise.reject(new CircularError("circular!"))
        );
        throw new Error("should not resolve");
      } catch (err) {
        assert.strictEqual(
          err.message,
          "circular!",
          "should propagate error message"
        );
      }
    });
  });
});

describe("serializeKey", () => {
  it("should normalize objects", () => {
    assert.strictEqual(
      serializeKey({ c: 1, b: [false, "s"], a: undefined }),
      '{"b":[false,"s"],"c":1}'
    );
  });
});
