// This file is doing some tricky things and `eslint` does not understand why.

/* eslint-disable @typescript-eslint/ban-types */

/**
 * Copy `obj`, excluding `keys`.
 *
 * This takes care to return an appropriate TypeScript type. Copied from
 * https://stackoverflow.com/a/53968837.
 */
export default function omit<T extends object, K extends [...(keyof T)[]]>(
  obj: T,
  ...keys: K
): {
  [K2 in Exclude<keyof T, K[number]>]: T[K2];
} {
  const ret = {} as {
    [K in keyof typeof obj]: typeof obj[K];
  };
  let key: keyof typeof obj;
  for (key in obj) {
    if (!keys.includes(key)) {
      ret[key] = obj[key];
    }
  }
  return ret;
}
