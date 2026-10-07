// The routes of the server list (/api/servers), which the local server answers on loopback
// alone. A secret goes out in a request's body and never comes back.
import { call } from "./api.ts";
import type { ServerForm, ServerView, TestResult } from "./logic/servers.ts";

/** GET /api/servers. notice = why the list file was set aside, or "". */
export type ServerList = { servers: ServerView[]; notice: string };
/** The answer of add and edit: saved is false when the test the server ran did not pass, with its result. */
export type SaveAnswer = { saved: boolean; server?: ServerView; result?: TestResult };
/** An edit's fields; one left out keeps its value, and so does an empty secret. */
export type ServerPatch = { name?: string; address?: string; secret?: string; selfSigned?: boolean; pin?: string };
/** What a test of a saved entry takes in place of its stored values. */
export type TestOver = { address?: string; secret?: string; selfSigned?: boolean; pin?: string };

const at = (id: string) => `/api/servers/${encodeURIComponent(id)}`;

export const serversApi = {
  list: () => call<ServerList>("GET", "/api/servers"),
  /** force = "save anyway": no test, and no request to that server before it connects. */
  add: (f: ServerForm, force: boolean) =>
    call<SaveAnswer>("POST", "/api/servers", { name: f.name, address: f.address, secret: f.secret, selfSigned: f.selfSigned, pin: f.pin, force }),
  edit: (id: string, patch: ServerPatch, force: boolean) => call<SaveAnswer>("PATCH", at(id), { ...patch, force }),
  remove: (id: string) => call<{ ok: boolean }>("DELETE", at(id)),
  /** The entry's chats and runs in this app. */
  items: (id: string) => call<{ chats: number; runs: number }>("GET", `${at(id)}/items`),
  /** Tests a form that is not saved. */
  test: (f: ServerForm) => call<TestResult>("POST", "/api/servers/test", { address: f.address, secret: f.secret, selfSigned: f.selfSigned, pin: f.pin }),
  /** Tests a saved entry; without `over` the entry also tries to connect again. */
  testSaved: (id: string, over?: TestOver) => call<TestResult>("POST", `${at(id)}/test`, over),
  accept: (id: string, fingerprint: string) => call<{ server: ServerView }>("POST", `${at(id)}/accept`, { fingerprint }),
};

export const { list, add, edit, remove, items, test, testSaved, accept } = serversApi;
