// Some custom logging from an older version. Not sure if this how we to handle
// this.

import { inspect } from "util";

/**
 * Supported log levels.
 *
 * These are in ascending order of severity so that we can compare them by type.
 */
export enum LogLevel {
  TRACE,
  DEBUG,
  INFO,
  WARN,
  ERROR,
}

/** Our current log level. */
let CURRENT_LOG_LEVEL: LogLevel;
{
  const logLevel = process.env.LOCK_AND_CACHE_LOG_LEVEL;
  switch (logLevel) {
    case "trace":
      CURRENT_LOG_LEVEL = LogLevel.TRACE;
      break;
    case "debug":
      CURRENT_LOG_LEVEL = LogLevel.DEBUG;
      break;
    case "info":
      CURRENT_LOG_LEVEL = LogLevel.INFO;
      break;
    case "warn":
      CURRENT_LOG_LEVEL = LogLevel.WARN;
      break;
    case "error":
      CURRENT_LOG_LEVEL = LogLevel.ERROR;
      break;
    default:
      if (logLevel == null) {
        CURRENT_LOG_LEVEL = LogLevel.WARN;
      } else {
        throw new Error(`unknown LOCK_AND_CACHE_LOG_LEVEL: ${logLevel}`);
      }
  }
}

/** Log a message at the specified level. */
export default function log(level: LogLevel, ...message: unknown[]): void {
  if (level < CURRENT_LOG_LEVEL) return;
  message = [new Date(), "lock_and_trace", ...message];
  console.log(
    ...message.map((m) => {
      if (typeof m === "string") return m.slice(0, 100);
      if (m instanceof Error) return m.stack;
      if (m instanceof Date) return m.toLocaleString();
      return inspect(m, { colors: Boolean(process.stdout.isTTY) });
    })
  );
}

log.trace = log.bind(null, LogLevel.TRACE);
log.debug = log.bind(null, LogLevel.DEBUG);
log.info = log.bind(null, LogLevel.INFO);
log.warn = log.bind(null, LogLevel.WARN);
log.error = log.bind(null, LogLevel.ERROR);
