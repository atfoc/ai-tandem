// The Store port of @aiwb/conn (ports.d.ts) for a process with one server and no files: the entry it was started with, in
// memory, and the client id it was given. The secret is in this object and in the connection's own memory, nowhere else: it is
// never written to a disk. A write (the connection stores the server's instance id on the first connect) is kept in memory.
import type { Store, StoredEntry } from "@aiwb/conn";

/** The version of the saved list that @aiwb/conn reads (core/list.js FILE_VERSION). */
const FILE_VERSION = 1;

export type MemStore = Store & { entry(): StoredEntry };

export function memStore(entry: StoredEntry, clientId: string): MemStore {
  let list: { version: number; servers: StoredEntry[] } = { version: FILE_VERSION, servers: [{ ...entry }] };
  return {
    where: "the headless writer's memory",
    read: () => structuredClone(list),
    write: (next) => { list = structuredClone(next); },
    setAside: () => { throw new Error("the headless writer keeps its server list in memory and has nothing to set aside"); },
    clientId: () => clientId,
    entry: () => ({ ...list.servers[0] }),
  };
}
