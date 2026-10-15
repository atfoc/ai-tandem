// The phone's Store (AD-13, goal D11), over two storages it is given: the secure storage, where every secret lives
// under `aiwb.secret.<entry id>`, and a key-value storage (MMKV instance `aiwb.servers`), where the list lives without
// secrets under `list` and the app's id under `client-id`. serverstore.native.ts gives it the real ones; the test gives
// it fakes. It behaves at the port as packages/conn/node/store.js does: an unreadable list is set aside under another
// name, never deleted; the client id is made once; the checks of an entry are core/list.js's, not made here.
//
// "A secret never leaves secure storage except to be sent to its server": a secret is read into the list's memory by
// read() and goes nowhere else; none is ever written to the key-value storage, a log line or an error text.
import type { Store, StoredEntry } from "@aiwb/conn";

/** What the Store needs of the key-value storage (MMKV's own methods fit). */
export type StoreKv = {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): boolean | void;
  getAllKeys(): string[];
};

/** What the Store needs of the secure storage (expo-secure-store's own functions fit, with `options` bound). */
export type SecretVault = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  /** There is no synchronous delete: it is started, and its failure is the caller's to keep for a retry. */
  delete(key: string): Promise<void>;
};

export type ServerStoreDeps = {
  kv: StoreKv;
  vault: SecretVault;
  /** A lower-case UUID v4. */
  randomUUID(): string;
  /** The clock of the name an unreadable list is set aside under (a test seam). */
  now?: () => Date;
};

export const LIST_KEY = "list";
export const CLIENT_ID_KEY = "client-id";
/** The ids of removed entries whose secret could not be deleted yet (no secret in it): deleted again at the next read or write. */
export const PENDING_KEY = "pending-secret-deletes";
export const SECRET_PREFIX = "aiwb.secret.";
export const UNREADABLE = `${LIST_KEY}.unreadable-`;

// The form of the app's id (core/list.js CLIENT_ID).
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

export function createServerStore({ kv, vault, randomUUID, now = () => new Date() }: ServerStoreDeps): Store {
  const secretKey = (id: string) => SECRET_PREFIX + id;

  // Ids of the entries in the saved list, as far as it can be read (an unreadable list has none to look after).
  function savedIds(): string[] {
    try {
      const text = kv.getString(LIST_KEY);
      const raw = text === undefined || text.trim() === "" ? null : JSON.parse(text);
      if (!isObject(raw) || !Array.isArray(raw.servers)) return [];
      return raw.servers.flatMap((x) => (isObject(x) && typeof x.id === "string" ? [x.id] : []));
    } catch {
      return [];
    }
  }

  function pending(): string[] {
    try {
      const v = JSON.parse(kv.getString(PENDING_KEY) ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  function setPending(ids: string[]) {
    if (ids.length === 0) kv.remove(PENDING_KEY);
    else kv.set(PENDING_KEY, JSON.stringify(ids));
  }

  // dropSecrets starts the deletion of the secrets of ids; one that fails stays in the pending list for the next time.
  function dropSecrets(ids: string[]) {
    const all = [...new Set([...pending(), ...ids])];
    if (all.length === 0) return;
    setPending(all);
    for (const id of all) {
      let done: Promise<void>;
      try {
        done = vault.delete(secretKey(id));
      } catch {
        continue;
      }
      done.then(() => setPending(pending().filter((x) => x !== id)), () => { /* stays pending */ });
    }
  }

  return {
    where: "the app's storage",

    // read: null when no list was saved. A list that cannot be read throws (the List sets it aside). The secrets are
    // joined from the secure storage; an entry without one has secret '' and core/list.js refuses it as bad_secret.
    read() {
      const text = kv.getString(LIST_KEY);
      if (text === undefined || text.trim() === "") return null;
      const raw: unknown = JSON.parse(text);
      if (!isObject(raw)) throw new Error("not an object");
      if (pending().length > 0) dropSecrets([]);
      if (!Array.isArray(raw.servers)) return raw as { version: number; servers: unknown[] };
      const servers = raw.servers.map((x) => {
        if (!isObject(x) || typeof x.id !== "string") return x;
        return { ...x, secret: vault.get(secretKey(x.id)) ?? "" };
      });
      return { ...raw, servers } as { version: number; servers: unknown[] };
    },

    // write: the secrets first, then the list without them, then the secrets of the entries that left the list. A
    // secret that cannot be saved throws before the list is touched.
    write(list) {
      const before = savedIds();
      for (const e of list.servers) vault.set(secretKey(e.id), e.secret);
      const bare = { ...list, servers: list.servers.map((e): StoredEntry => ({ ...e, secret: "" })) };
      kv.set(LIST_KEY, JSON.stringify(bare));
      const kept = new Set(list.servers.map((e) => e.id));
      dropSecrets(before.filter((id) => !kept.has(id)));
    },

    // setAside moves the list to `list.unreadable-<UTC stamp>` (-2, -3… when that is taken) and answers that name.
    setAside() {
      const text = kv.getString(LIST_KEY);
      if (text === undefined) throw new Error("no saved list");
      const taken = new Set(kv.getAllKeys());
      const base = UNREADABLE + stamp(now());
      let name = base;
      for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
      kv.set(name, text);
      kv.remove(LIST_KEY);
      return name;
    },

    clientId() {
      const saved = kv.getString(CLIENT_ID_KEY)?.trim();
      if (saved !== undefined && CLIENT_ID.test(saved)) return saved;
      const id = randomUUID();
      kv.set(CLIENT_ID_KEY, id);
      return id;
    },
  };
}
