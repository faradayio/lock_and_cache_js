import test from "blue-tape";
import cache from "../lib";

let executionCount = 0;
async function double(a: number) {
  executionCount++;
  return a * 2;
}

const cachedDouble = cache.wrap(1, double);

let undefExecutionCount = 0;
async function undef() {
  undefExecutionCount++;
  return undefined;
}

const cachedUndefined = cache.wrap(1, undef);

function cachedStandaloneDouble(a: number) {
  return cache(["standaloneDouble", a], 1, async function () {
    executionCount++;
    return a * 2;
  });
}

test("basic", async function (t) {
  executionCount = 0;
  let four = await cachedDouble(2);
  t.equal(four, 4);
  t.equal(executionCount, 1);
  four = await cachedDouble(2);
  t.equal(four, 4);
  t.equal(executionCount, 1);
});

test("parallel", async function (t) {
  executionCount = 0;
  const results = await Promise.all(
    [1, 4, 3, 3, 4, 1].map((d) => cachedDouble(d))
  );
  t.deepEqual(results, [2, 8, 6, 6, 8, 2]);
  t.equal(executionCount, 3);
});

test("standalone", async function (t) {
  executionCount = 0;
  const results = await Promise.all(
    [1, 4, 3, 3, 4, 1].map(cachedStandaloneDouble)
  );
  t.deepEqual(results, [2, 8, 6, 6, 8, 2]);
  t.equal(executionCount, 3);
});

test("fail", async function (t) {
  const expectedErr = new Error("test me please");
  try {
    await cache("fail_test", 1, () => Promise.reject(expectedErr));
    t.fail("should not resolve");
  } catch (err) {
    t.equal(err.name, expectedErr.name, "should propagate error name");
    t.equal(err.message, expectedErr.message, "should propagate error message");
    t.equal(err.stack, expectedErr.stack, "should propagate error stack");
  }
});

test("basic", async function (t) {
  undefExecutionCount = 0;
  let un = await cachedUndefined();
  t.equal(un, undefined);
  t.equal(undefExecutionCount, 1);
  un = await cachedUndefined();
  t.equal(un, undefined);
  t.equal(undefExecutionCount, 1);
});