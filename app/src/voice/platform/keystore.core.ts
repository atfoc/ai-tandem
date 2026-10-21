// The key's store over a vault (architecture VC-2): the same rules for the phone's secure storage and for the web build's memory.
// The vault is a place that holds one string under a name; this checks the key before it is kept, reports `has` without handing the
// key out, and never puts the key in an error.
import type { Keystore } from "../ports.ts";

/** The name the key is kept under (the secure store's key on a phone). */
export const KEY_NAME = "aiwb.voice.elevenlabs";

export interface KeyVault {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** The key as it is kept: trimmed, printable ASCII without spaces (it goes into a header), at most 256 characters. Throws a plain error
 *  that does not carry the text. */
export function cleanKey(key: string): string {
  const k = key.trim();
  if (!/^[\x21-\x7e]{1,256}$/.test(k)) throw new Error("voice: that is not a key");
  return k;
}

export function createKeystore(vault: KeyVault): Keystore {
  return {
    async has() { return Boolean(await vault.get(KEY_NAME)); },
    async get() { return (await vault.get(KEY_NAME)) || null; },
    async set(key) { await vault.set(KEY_NAME, cleanKey(key)); },
    async clear() { await vault.delete(KEY_NAME); },
  };
}

/** A vault in memory: gone on reload. */
export function memoryVault(): KeyVault {
  const held = new Map<string, string>();
  return {
    get: async (name) => held.get(name) ?? null,
    set: async (name, value) => { held.set(name, value); },
    delete: async (name) => { held.delete(name); },
  };
}
