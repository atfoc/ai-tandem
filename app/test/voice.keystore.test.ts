// The key's stores (architecture VC-2, VC-3) over fakes: the phone's vault rules, the web build's memory and the desktop's proxy.
// Loaded by Node: the files under test import no react-native and no expo-*.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { KEY_NAME, cleanKey, createKeystore, memoryVault, type KeyVault } from "../src/voice/platform/keystore.core.ts";
import { webKeystore } from "../src/voice/platform/keystore.web.ts";
import type { AiwbVoiceBridge } from "../src/voice/platform/bridge.types.ts";

const KEY = "sk_test_RecognisableKey0123";
const src = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/voice/platform", f), "utf8");

/** A vault that records what is asked of it. */
function spyVault(): KeyVault & { calls: string[]; held: Map<string, string> } {
  const held = new Map<string, string>();
  const calls: string[] = [];
  return {
    held, calls,
    get: async (n) => { calls.push(`get ${n}`); return held.get(n) ?? null; },
    set: async (n, v) => { calls.push(`set ${n}`); held.set(n, v); },
    delete: async (n) => { calls.push(`delete ${n}`); held.delete(n); },
  };
}

describe("the keystore over a vault (the phone)", () => {
  it("keeps the key under aiwb.voice.elevenlabs and nowhere else", async () => {
    const v = spyVault();
    const k = createKeystore(v);
    assert.equal(KEY_NAME, "aiwb.voice.elevenlabs");
    assert.equal(await k.has(), false);
    await k.set(`  ${KEY}\n`);
    assert.deepEqual([...v.held], [[KEY_NAME, KEY]], "trimmed, and the only thing kept");
    assert.equal(await k.has(), true);
    assert.equal(await k.get?.(), KEY);
    await k.clear();
    assert.equal(await k.has(), false);
    assert.equal(await k.get?.(), null);
    assert.ok(v.calls.every((c) => c.endsWith(KEY_NAME)));
  });

  it("does not read the vault until a method is called", () => {
    const v = spyVault();
    createKeystore(v);
    assert.deepEqual(v.calls, []);
  });

  it("refuses what cannot be a header value, without the text in the error", async () => {
    const k = createKeystore(spyVault());
    for (const bad of ["", "   ", "two words", "line\nbreak", "tab\there", "café", "x".repeat(257)]) {
      await assert.rejects(k.set(bad), (e: Error) => !e.message.includes(bad.trim() || "\u0000") && /not a key/.test(e.message));
    }
    assert.equal(cleanKey(KEY), KEY);
  });

  it("is in the secure store with the server secrets' options, and uses nothing else", () => {
    const text = src("keystore.native.ts");
    assert.match(text, /keychainAccessible: SecureStore\.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY/);
    assert.match(text, /SecureStore\.getItemAsync\(name, OPTIONS\)/);
    assert.match(text, /SecureStore\.setItemAsync\(name, value, OPTIONS\)/);
    assert.match(text, /SecureStore\.deleteItemAsync\(name, OPTIONS\)/);
    assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|console\./i);
  });
});

describe("the web build's keystore", () => {
  it("in a browser is memory: it has get, and holds nothing in any storage", async () => {
    const touched: string[] = [];
    const trap = new Proxy({}, { get: (_t, p) => { touched.push(String(p)); return () => { throw new Error("storage used"); }; } });
    Object.assign(globalThis, { localStorage: trap, sessionStorage: trap, indexedDB: trap, document: { get cookie() { touched.push("cookie"); return ""; }, set cookie(_v: string) { touched.push("cookie="); } } });
    try {
      const k = webKeystore({});
      assert.equal(await k.has(), false);
      await k.set(KEY);
      assert.equal(await k.has(), true);
      assert.equal(await k.get?.(), KEY);
      assert.equal(await webKeystore({}).has(), false, "a second window's store is its own (gone on reload)");
      await k.clear();
      assert.equal(await k.has(), false);
      assert.deepEqual(touched, []);
    } finally {
      for (const n of ["localStorage", "sessionStorage", "indexedDB", "document"]) delete (globalThis as Record<string, unknown>)[n];
    }
  });

  it("in the desktop window is a proxy of main's: no get, and the key crosses once, in set", async () => {
    const calls: [string, ...unknown[]][] = [];
    let stored = false;
    const bridge = {
      key: {
        has: async () => { calls.push(["has"]); return stored; },
        set: async (k: string) => { calls.push(["set", k]); stored = true; },
        clear: async () => { calls.push(["clear"]); stored = false; },
      },
    } as unknown as AiwbVoiceBridge;
    const k = webKeystore({ aiwbVoice: bridge });
    assert.equal(k.get, undefined, "the key never enters the page");
    assert.equal(await k.has(), false);
    await k.set(` ${KEY} `);
    assert.equal(await k.has(), true);
    await k.clear();
    assert.equal(await k.has(), false);
    assert.deepEqual(calls.map((c) => c[0]), ["has", "set", "has", "clear", "has"]);
    assert.deepEqual(calls.filter((c) => c[0] === "set"), [["set", KEY]]);
    await assert.rejects(k.set("not a key"), /not a key/);
    assert.equal(calls.filter((c) => c[0] === "set").length, 1, "a bad key does not reach main");
  });

  it("memoryVault is a plain map", async () => {
    const v = memoryVault();
    await v.set("a", "1");
    assert.equal(await v.get("a"), "1");
    await v.delete("a");
    assert.equal(await v.get("a"), null);
  });
});
