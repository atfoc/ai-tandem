// The operations on the server list ("servers.*" of the app, through the transport). The app holds the list and the
// secrets: a secret goes out in a call's arguments and never comes back.
import { appCall } from "./api.ts";
import type { ServerForm, ServerView, TestResult } from "./logic/servers.ts";

/** servers.list. notice = why the list file was set aside, or "". */
export type ServerList = { servers: ServerView[]; notice: string };
/** The answer of add and edit: saved is false when the test the app ran did not pass, with its result. */
export type SaveAnswer = { saved: boolean; server?: ServerView; result?: TestResult };
/** An edit's fields; one left out keeps its value, and so does an empty secret. */
export type ServerPatch = { name?: string; address?: string; secret?: string; selfSigned?: boolean; pin?: string };
/** What a test of a saved entry takes in place of its stored values. */
export type TestOver = { address?: string; secret?: string; selfSigned?: boolean; pin?: string };

export const serversApi = {
  list: () => appCall<ServerList>("servers.list"),
  /** force = "save anyway": no test, and no request to that server before it connects. */
  add: (f: ServerForm, force: boolean) =>
    appCall<SaveAnswer>("servers.add", { form: { name: f.name, address: f.address, secret: f.secret, selfSigned: f.selfSigned, pin: f.pin }, force }),
  edit: (id: string, patch: ServerPatch, force: boolean) => appCall<SaveAnswer>("servers.edit", { id, patch, force }),
  remove: (id: string) => appCall<{ ok: boolean }>("servers.remove", { id }),
  /** Tests a form that is not saved. */
  test: (f: ServerForm) => appCall<TestResult>("servers.test", { form: { address: f.address, secret: f.secret, selfSigned: f.selfSigned, pin: f.pin } }),
  /** Tests a saved entry; without `over` the entry also tries to connect again. */
  testSaved: (id: string, over?: TestOver) => appCall<TestResult>("servers.testSaved", { id, ...(over ? { over } : {}) }),
  accept: (id: string, fingerprint: string) => appCall<{ server: ServerView }>("servers.accept", { id, fingerprint }),
};

export const { list, add, edit, remove, test, testSaved, accept } = serversApi;
