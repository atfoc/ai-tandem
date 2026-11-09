// What an account's buttons do beyond one call (multiple-claude goal §1.6.3–§1.6.6, §4.3): Restart container and Stop container ask the
// server first without force; an answer `busy` (agents work in the container) asks the person (restartDialog: Later / Restart now;
// stopDialog: Cancel / Stop now), whose yes calls again with force. Idle, it is done at once and nothing is asked. Remove account always
// asks (removeDialog names what is lost). The dialogs are the shell's confirm (screens/shell/confirm.ts), a P4 sheet on the phone.
import type { Alias, AliasChange } from "@aiwb/core/aliasesapi.ts";
import { removeDialog, restartDialog, stopDialog, type Dialog } from "@aiwb/core/logic/aliases.ts";
import { removeAccount, restartAccount, stopAccount } from "@aiwb/core/state/aliases.ts";

import { confirm, reportError } from "../../shell/confirm.ts";

/** Asks with a dialog of core's words; its action runs `run` (a throw stays in the dialog with its sentence). */
export function ask(d: Dialog, run: () => Promise<unknown>, tone: "primary" | "danger" = "primary"): void {
  confirm({ title: d.title, body: d.body, cancelLabel: d.cancel, confirmLabel: d.ok, actions: [{ label: d.ok, tone, run: async () => { await run(); } }] });
}

/** After a change answered `busy`: the restart dialog (Later leaves the account pending). */
export function askRestart(server: string, a: Pick<Alias, "id" | "name">, busy: number): void {
  ask(restartDialog(a.name, busy), () => restartAccount(server, a.id, true));
}

/** Restart container: at once when idle, else asked. A failure is shown. */
export async function restart(server: string, a: Alias): Promise<void> {
  let ch: AliasChange;
  try { ch = await restartAccount(server, a.id, false); } catch (e) { reportError(`Could not restart ${a.name}`, e); return; }
  if (ch.restart === "busy") askRestart(server, a, ch.busy ?? a.busy);
}

/** Stop container: at once when idle, else asked (Cancel / Stop now). A failure is shown. */
export async function stop(server: string, a: Alias): Promise<void> {
  let ch: AliasChange;
  try { ch = await stopAccount(server, a.id, false); } catch (e) { reportError(`Could not stop ${a.name}`, e); return; }
  if (ch.restart === "busy") ask(stopDialog(a.name, ch.busy ?? a.busy), () => stopAccount(server, a.id, true));
}

/** Remove account: always asked, naming what is lost; `done` runs after it is removed (the sheet closes). */
export function remove(server: string, a: Alias, done?: () => void): void {
  ask(removeDialog(a.name, a.busy), async () => { await removeAccount(server, a.id); done?.(); }, "danger");
}
