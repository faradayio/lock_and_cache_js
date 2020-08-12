import assert from "assert";

import log from "./log";

/**
 * What state is our `Sleeper` in?
 *
 * This type union uses TypeScript magic to work like a Rust enumeration. When
 * we compare `this.state.name` against a known state name, TypeScript narrows
 * down the fields available on our state.
 *
 * We use this relatively heavyweight state tracking representation because we
 * have a number of member variables that are only present in certain states,
 * and we want to be very careful about how we manage them.
 */
type SleeperState = ReadyState | SleepingState | CanceledForAllTimeState;

/** We are ready to sleep. */
type ReadyState = {
  /** The name of this state. */
  name: "READY";
};

/** We are currently sleeping. */
type SleepingState = {
  /** The name of this state. */
  name: "SLEEPING";

  /** The timeout that will fire when the sleep ends. */
  timeoutHandle: NodeJS.Timeout;

  /**
   * Somebody is calling `await sleeper.sleepSecs`. Calling this will wake them
   * up.
   */
  resolve: () => void;
};

/** We will never sleep again. */
type CanceledForAllTimeState = {
  /** The name of this state. */
  name: "CANCELED_FOR_ALL_TIME";
};

/** A utility class that provides interruptible sleep. */
export class Sleeper {
  /** The state of this `Sleeper`. */
  private state: SleeperState;

  /**
   * Create a new `Sleeper`.
   *
   * ```
   * const sleeper = new Sleeper();
   * await sleeper.sleepSecs(30);
   *
   * // In another task.
   * sleeper.cancelCurrentAndFutureSleeps();
   * ```
   */
  constructor() {
    this.state = { name: "READY" };
  }

  /**
   * Sleep for the specified number of seconds. This may be interrupted using
   * `cancelCurrentAndFutureSleeps`. Only one sleep may be running at a time.
   *
   * @param secs The number of seconds to sleep.
   */
  sleepSecs(secs: number): Promise<void> {
    log.trace("sleepSecs", secs, "in", this.state.name);

    // If we've been canceled, don't even start sleeping.
    if (this.state.name === "CANCELED_FOR_ALL_TIME") {
      // Return a pre-resolved promise.
      return Promise.resolve();
    }

    // Install a timeout with a callback.
    assert(
      this.state.name === "READY",
      `cannot sleep in state ${JSON.stringify(this.state)}`
    );
    return new Promise((resolve) => {
      this.state = {
        name: "SLEEPING",
        resolve,
        timeoutHandle: setTimeout(() => {
          this.wakeUpAfterTimeout();
        }, secs * 1000),
      };
    });
  }

  /** Internal function called at the end of a regular sleep. */
  private wakeUpAfterTimeout(): void {
    log.trace("wakeUpAfterTimeout in", this.state.name);
    assert(
      this.state.name === "SLEEPING",
      `Tried to wake up in state ${this.state.name}`
    );
    const { resolve } = this.state;
    resolve();
    // `this.state.timeoutHandle` fired, so it should already be clear.
    this.state = { name: "READY" };
  }

  /**
   * Cancel the current sleep, if any, making it return immediately. Any future
   * sleeps will also return immediately.
   *
   * This can be called at any time, and any number of times.
   */
  cancelCurrentAndFutureSleeps(): void {
    log.trace("cancelCurrentAndFutureSleeps in", this.state.name);
    switch (this.state.name) {
      case "READY": {
        this.state = { name: "CANCELED_FOR_ALL_TIME" };
        break;
      }

      case "SLEEPING": {
        const { resolve, timeoutHandle } = this.state;
        clearTimeout(timeoutHandle);
        resolve();
        this.state = { name: "CANCELED_FOR_ALL_TIME" };
        break;
      }

      case "CANCELED_FOR_ALL_TIME":
        break;

      default:
        assert.fail("Sleeper is in an impossible state");
    }
  }
}
