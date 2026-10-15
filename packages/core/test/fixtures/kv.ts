// The kv port of the store (AD-12) over the browser's localStorage, as the page gave it: the tests give `globalThis` a
// localStorage of their own when they need one. Every call may throw (storage refused or full); the store catches that.
import type { Kv } from "@aiwb/core/state/ports.ts";

export const localStorageKv: Kv = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  remove: (k) => localStorage.removeItem(k),
  keys: () => Object.keys(localStorage),
};
