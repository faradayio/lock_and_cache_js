import assert from "assert";

import { AsyncRedis } from "./asyncRedis";
import log from "./log";
import { Sleeper } from "./sleeper";

/**
 * Generate a short random string with about 11 characters. This is not
 * cryptographically secure.
 */
function randomString(): string {
  // Take a random number, convert it to a base 36 decimal like '0.w6cmc1rh0bl',
  // and chop off the leading two digits.
  return Math.random().toString(36).substring(2);
}

/** The current time, in seconds. */
function currentTimeInSeconds(): number {
  // This is a standard JavaScript trick to get seconds from a `Date` by
  // coercing it from a number-like object to a true number.
  return +new Date();
}

/** A lock-related error. */
export class LockError extends Error {}

/** We failed to acquire a lock. */
export class LockingFailedError extends LockError {
  constructor() {
    super("the Redis key we want to lock is already locked");
  }
}

/** Thrown when a lock expires unexpectedly. */
export class LockExpiredError extends LockError {
  constructor() {
    super("a Redis lock expired before we could unlock it");
  }
}

/** A lock was stolen out from under us. */
export class LockTakenError extends LockError {
  constructor() {
    super("a Redis lock was unexpectedly taken by another process");
  }
}

/** An unexpcted Redis error occurred while locking. */
export class UnexpectedLockError extends LockError {}

/** What state is our `Lock` in? */
enum LockState {
  /** Constructed but not locked. Lock it now! */
  NotYetLocked,
  /** We're trying to acquire our initial lock. */
  TryingToLock,
  /** We've got our initial lock but it's going to expire soon. */
  Locked,
  /** We've got our initial lock and we're extending it. */
  ExtendingLock,
  /** We're releasing our lock. */
  Releasing,
  /** We've released our lock. Make a new `Lock` if want a new one. */
  Released,
  /** We never acquired our lock in the first place. */
  FailedToLock,
  /**
   * Some sketchy Redis error occurred in our locking operations. This lock is
   * toast and you should just bail.
   */
  DiedWithRedisError,
}

/** A simple Redis locking API that is tuned to our needs. */
export class Lock {
  /**
   * The current state of this lock.
   *
   * We use a proper state variable instead of a bunch of booleans with names
   * like `extending` and `done`, because this allows us to make sure the state
   * is always clear and consisent and not some "impossible" combination of
   * other booleans.
   */
  private state: LockState;

  /** The Redis client to use. */
  private redis: AsyncRedis;

  /** The Redis key holding our lock. */
  private key: string;

  /**
   * A random secret value used to identify us. We store this in the lock so we
   * know it's ours.
   */
  private secret: string;

  /**
   * How long should each "heartbeat" renew our lock for?
   */
  private heartbeatExpiresSecs: number;

  /**
   * How long should we wait to acquire our lock?
   */
  private maxLockWaitSecs: number;

  /** We use this to sleep and to interrupt sleeping. */
  private sleeper: Sleeper;

  /**
   * A promise that will resovle when our background heartbeat worker exits.
   */
  private heartbeatWorkerHandle: Promise<void> | null;

  /**
   * Create a `Lock` object for the specified key. This does not actually take
   * the lock, because that's an asynchronous operation.
   *
   * There are two important rules to follow:
   *
   * 1. After constructing this, call `await lock.lock()` immediately.
   * 2. When you're done with this, you _must_ call `release`.
   *
   * ```
   * const lock = new Lock(redis, key);
   * await lock.lock(); // Short-term lock only.
   * try {
   *   // Optionally make this lock last indefinitely:
   *   lock.extendIndefinitely();
   *
   *   // Do a locked operation.
   * } finally {
   *   await lock.release();
   * }
   * ```
   *
   * @param redis The client to use to talk to Redis.
   * @param key The key to use for the lock in Redis.
   */
  constructor(redis: AsyncRedis, key: string) {
    this.state = LockState.NotYetLocked;
    this.redis = redis;
    this.key = key;
    this.secret = randomString();
    this.heartbeatExpiresSecs = 32;
    this.maxLockWaitSecs = 60 * 60 * 24; // 1 day.
    this.sleeper = new Sleeper();
    this.heartbeatWorkerHandle = null;
  }

  /**
   * Take the lock, and hold it for a short number of seconds (around 30).
   */
  async lock(): Promise<void> {
    assert(this.state === LockState.NotYetLocked, "can only lock a lock once");
    this.state = LockState.TryingToLock;
    const endTime = currentTimeInSeconds() + this.maxLockWaitSecs;
    const lockSleeper = new Sleeper();
    while (this.state === LockState.TryingToLock) {
      try {
        await this.lockRedisLock();
        this.state = LockState.Locked;
      } catch (e) {
        // If we've been waiting too long, give up.
        if (currentTimeInSeconds() >= endTime) {
          this.state = LockState.FailedToLock;
          throw e;
        }

        log.trace("failed to obtain lock, retrying:", e.message);
        // Sleep for 0 to 1 seconds. We use a local sleeper because having this
        // sleep be interrupted would only cause us to query Redis too quickly.
        await lockSleeper.sleepSecs(Math.random());
      }
    }
    if (this.state !== LockState.Locked) {
      throw new LockError("timed out waiting for lock");
    }
  }

  /**
   * If you need to hold this lock longer, you can call this function to request
   * that the lock be renewed periodically until you call `release`.
   */
  extendIndefinitely(): void {
    assert(
      this.state === LockState.Locked,
      "can only extend a lock once, and after calling lock"
    );
    this.state = LockState.ExtendingLock;
    this.heartbeatWorkerHandle = this.heartbeatWorker();
  }

  /**
   * Periodically renew our lock in the background.
   */
  private async heartbeatWorker(): Promise<void> {
    assert(this.state >= LockState.Locked, "heartbeat worker started too soon");
    while (this.state === LockState.ExtendingLock) {
      await this.extendRedisLock();
      await this.sleeper.sleepSecs(this.heartbeatExpiresSecs / 2);
    }
  }

  /**
   * Release this lock.
   *
   * **This poisons the this lock object and you can't use it again.**
   */
  async release(): Promise<void> {
    assert(
      this.state === LockState.Locked ||
        this.state === LockState.ExtendingLock ||
        LockState.DiedWithRedisError,
      "can only release something you've locked"
    );
    if (this.state === LockState.DiedWithRedisError) {
      // We're probably getting called from a `finally` block, so don't do
      // anything.
      return;
    }
    this.state = LockState.Releasing;
    this.sleeper.cancelCurrentAndFutureSleeps();
    if (this.heartbeatWorkerHandle !== null) {
      await this.heartbeatWorkerHandle;
      this.heartbeatWorkerHandle = null;
    }
    await this.unlockRedisLock();
    this.state = LockState.Released;
  }

  /**
   * Lock `this.key` in Redis using `this.secret`.
   *
   * Throws `LockingFailedError` if somebody else already has the lock.
   */
  private async lockRedisLock(): Promise<void> {
    const r = await this.redis.set(
      this.key,
      this.secret,
      "nx",
      "px",
      this.heartbeatExpiresSecs
    );
    if (!r) {
      throw new LockingFailedError();
    }
  }

  /** Extend the lock on `this.key` in Redis. */
  private async extendRedisLock(): Promise<void> {
    const r = await this.redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        if redis.call("get", KEYS[1]) == false then
          return -1
        else
          return -2
        end
      end`,
      1,
      this.key,
      this.secret,
      this.heartbeatExpiresSecs
    );
    if (r === 0) {
      this.state = LockState.DiedWithRedisError;
      throw new UnexpectedLockError("pexpire failed; this should NEVER happen");
    }
    if (r === -1) {
      this.state = LockState.DiedWithRedisError;
      throw new LockExpiredError();
    }
    if (r === -2) {
      this.state = LockState.DiedWithRedisError;
      throw new LockTakenError();
    }
  }

  /** Unlock `this.key` in Redis using `this.secret`. */
  private async unlockRedisLock(): Promise<void> {
    const r = await this.redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        if redis.call("get", KEYS[1]) == false then
          return -1
        else
          return -2
        end
      end`,
      1,
      this.key,
      this.secret
    );
    if (r === 0) {
      this.state = LockState.DiedWithRedisError;
      throw new UnexpectedLockError("del failed; this should NEVER happen");
    }
    if (r === -1) {
      this.state = LockState.DiedWithRedisError;
      throw new LockExpiredError();
    }
    if (r === -2) {
      this.state = LockState.DiedWithRedisError;
      throw new LockTakenError();
    }
  }
}
