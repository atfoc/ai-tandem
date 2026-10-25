// What the Servers dialog does to the store, which is the same for every UI that draws it (the old page's Servers.tsx, the app's
// screens/servers): open it, read the list it opens on, and take the entry in an answer of an add, an edit or an accept.
import { insertServer, serversOf, type ServerForm, type ServerView } from "../logic/servers.ts";
import { setState, withServers } from "./store.ts";

/** The entry in the answer of an add, an edit or an accept. The store's entries come from the stream
 *  (`snapshot`, `servers`, `server_state`), whose events may be here before the answer: the answer's
 *  view only adds an entry the store does not have yet, and never replaces one. */
export function answered(v?: ServerView | null): void {
  if (v?.id) setState((s) => withServers(s, insertServer(s.servers, v)));
}

/** The list the dialog reads when it opens: its notice, and the entries the store does not have. */
export function listed(l?: { servers?: ServerView[] | null; notice?: string } | null): void {
  setState((s) => ({ ...withServers(s, serversOf(l ?? {}).servers.reduce(insertServer, s.servers)), serversNotice: l?.notice ?? "" }));
}

/** Opens the dialog; with a form, on that form (an entry to add or, with an id, to edit). */
export function openServers(form?: ServerForm): void { setState({ serversDialog: form ? { form } : {} }); }
