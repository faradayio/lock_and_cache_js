// Type definitions for cache-manager-redis-store

declare module "cache-manager-redis-store" {
  import cache_manager from "cache-manager";
  import { RedisClient } from "redis";

  // Re-open `cache-manager` `Store` and monkey-patch the type.
  export module "cache-manager" {
    export interface Store {
      /** Fetch the Redis client associated with this store, if any. */
      getClient?(): RedisClient;
    }
  }

  // TypeScript will force us to replace this with a real export once we turn on
  // strict mode.
  export default {};
}
