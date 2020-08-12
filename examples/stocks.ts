/* eslint-disable @typescript-eslint/no-unused-vars */

import { LockAndCache } from "../lib";

const cache = new LockAndCache();

// Wrap mode.
async function computeStockQuote(symbol: string) {
  // Fetch stock price from remote source, cache for one minute.
  //
  // Calling this multiple times in parallel will only run it once the cache key
  // is based on the function name and arguments.
  return 100;
}
const stockQuote = cache.wrap({ ttl: 60 }, computeStockQuote);

// Standalone mode.
function getStockQuote(symbol: string) {
  return cache.get(["stock", symbol], { ttl: 60 }, async () => {
    // Fetch stock price from remote source, cache for one minute.
    //
    // Calling this multiple times in parallel will only run it once.
    return 100;
  });
}

// If you forget this, your process will never exit.
cache.close();
