import { promisify } from "util";
import { RedisClient } from "redis";

/**
 * A simple asynchronous Redis client.
 */
export class AsyncRedis {
  /**
   * Get the value associated with a Redis key.
   *
   * See https://redis.io/commands/get
   */
  get: (key: string) => Promise<string | null>;

  /**
   * Set the value associated with a Redis key.
   *
   * See https://redis.io/commands/set
   */
  set: (
    key: string,
    value: string,
    ...options: (string | number)[]
  ) => Promise<unknown>;

  /**
   * Delete one or more Redis keys.
   *
   * See https://redis.io/commands/del
   */
  del: (...keys: string[]) => Promise<number>;

  /**
   * Get the TTL of a Redis key, in seconds.
   *
   * - Returns -2 if the key does not exist.
   * - Returns -1 if the key exists but has no associated expire
   *
   * See https://redis.io/commands/ttl
   */
  ttl: (key: string) => Promise<number>;

  /**
   * Evaluate a Redis expression.
   *
   * See https://redis.io/commands/eval
   *
   * @param code The code to run.
   * @param keyCount The number of `keysAndArgs` values to put in the `KEYS`
   * array. These will be taken first from `keysAndArgs`.
   * @param keysAndArgs The values to put in the `KEYS` and `ARGV` arrays.
   */
  eval: (
    code: string,
    keyCount: number,
    ...keysAndArgs: (string | number)[]
  ) => Promise<number>;

  /**
   * Ask the server to close the connection.
   *
   * See https://redis.io/commands/quit
   */
  quit: () => Promise<"OK">;

  /**
   * Create a new asynchronous Redis client.
   *
   * @param client A regular Redis client to wrap.
   */
  constructor(client: RedisClient) {
    this.get = promisify(client.get).bind(client);
    this.set = promisify(client.set).bind(client);
    this.del = promisify(client.del).bind(client);
    this.ttl = promisify(client.ttl).bind(client);
    this.eval = promisify(client.eval).bind(client);
    this.quit = promisify(client.quit).bind(client);
  }
}
