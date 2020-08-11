import { assert } from "console";

import log from "./log";

/** What state is our `Sleeper` in? */
enum SleeperState {
  /** We are ready to sleep. */
  Ready,
  /** We are currently sleeping. */
  Sleeping,
  /** We will never sleep again. */
  CanceledForAllTime,
}

/** A utility class that provides interruptible sleep. */
export class Sleeper {
  /** The state of this `Sleeper`. */
  private state: SleeperState;

  /**
   * If this handle is present, we have a sleep timeout queued up.
   */
  private timeoutHandle: NodeJS.Timeout | null;

  /**
   * If this function is present, somebody is waiting on `sleepSecs`. Calling
   * this will wake them up.
   *
   * Technically I think JavaScript allows us to call this more than once, but
   * we try to avoid doing that.
   */
  private resolve: (() => void) | null;

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
    this.state = SleeperState.Ready;
    this.timeoutHandle = null;
    this.resolve = null;
  }

  /**
   * Sleep for the specified number of seconds. This may be interrupted using
   * `cancelCurrentAndFutureSleeps`. Only one sleep may be running at a time.
   *
   * @param secs The number of seconds to sleep.
   */
  sleepSecs(secs: number): Promise<void> {
    log.trace("sleepSecs", secs);
    // If we've been canceled, don't even start sleeping.
    if (this.state === SleeperState.CanceledForAllTime) {
      // Return a pre-resolved promise.
      return Promise.resolve();
    }

    // Install a timeout with a callback.
    assert(
      this.state === SleeperState.Ready,
      `cannot sleep in state ${this.state}`
    );
    assert(
      this.resolve === null,
      "found existing resolver when we want to sleep"
    );
    this.state = SleeperState.Sleeping;
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.timeoutHandle = setTimeout(() => {
        this.wakeUpAfterTimeout();
      }, secs * 1000);
    });
  }

  /** Internal function called at the end of a regular sleep. */
  private wakeUpAfterTimeout(): void {
    log.trace("wakeUpAfterTimeout");
    assert(
      this.state === SleeperState.Sleeping ||
        this.state == SleeperState.CanceledForAllTime,
      "Tried to wake up when we were already awake"
    );
    this.resolveIfSleeping();
    this.timeoutHandle = null;
    if (this.state === SleeperState.Sleeping) this.state = SleeperState.Ready;
  }

  /**
   * Cancel the current sleep, if any, making it return immediately. Any future
   * sleeps will also return immediately.
   *
   * This can be called at any time, and any number of times.
   */
  cancelCurrentAndFutureSleeps(): void {
    log.trace("cancelCurrentAndFutureSleeps");
    this.state = SleeperState.CanceledForAllTime;
    this.resolveIfSleeping();

    // Even though this timeout will do nothing, clear it so that it doesn't
    // keep the process running.
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  /** If we have `this.resolve`, call it. */
  private resolveIfSleeping(): void {
    log.trace("resolveIfSleeping", this.resolve);
    assert(
      this.state === SleeperState.Sleeping ||
        this.state == SleeperState.CanceledForAllTime,
      "Tried to resolve our promise when we were already awake"
    );
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }
}
