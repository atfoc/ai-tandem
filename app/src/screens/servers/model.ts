// The Servers dialog's rules that need no screen: where it has the owner's things, which rows it lists, a row's tone, the form an edit starts
// from and the patch an edit sends. Where the Servers dialog has the owner's things (the old page's Servers.tsx `LocalRow`): this computer's row, with its state, the start's
// reason, the state of its MCP listener and the buttons "Restart server", "Retry" and "Open server log". They are the desktop app's
// (and the test host's), which run a server of their own: a phone or a tablet has none (goal 4.1), so its transport is `native` and
// the dialog lists the servers of the list alone, with no `owner.*` call and no row of this computer. No React here.
import { transport } from "@aiwb/core/transport/index.ts";
import type { ServerForm, ServerView } from "@aiwb/core/logic/servers.ts";
import type { ServerPatch } from "@aiwb/core/serversapi.ts";

/** Whether the way the app reaches its servers offers the owner's things (the desktop's ipc and the host's http do; native does not). */
export const ownerThings = (): boolean => transport().way !== "native";

/** The rows the dialog lists: the list as the store has it, without this computer's entry where there is no such server. */
export const rowsOf = (list: readonly ServerView[], owner: boolean): ServerView[] => (owner ? [...list] : list.filter((v) => !v.local));

/** The tone of a state: connected is green, connecting waits, every other is red. */
export const toneOf = (state: ServerView["state"]): "ok" | "wait" | "bad" => (state === "connected" ? "ok" : state === "connecting" ? "wait" : "bad");

/** An entry's edit form: the secret empty, which keeps the stored one. */
export const editForm = (v: ServerView): ServerForm => ({ id: v.id, name: v.name, address: v.address ?? "", secret: "", selfSigned: !!v.selfSigned, pin: v.pin ?? "" });

/** An edit sends what changed, so that a new name alone does not connect again; an empty secret keeps the stored one. */
export function patchOf(f: ServerForm, was: ServerForm): ServerPatch {
  const p: ServerPatch = {};
  if (f.name !== was.name) p.name = f.name;
  if (f.address !== was.address) p.address = f.address;
  if (f.secret) p.secret = f.secret;
  if (f.selfSigned !== was.selfSigned) p.selfSigned = f.selfSigned;
  if (f.pin !== was.pin) p.pin = f.pin;
  return p;
}
