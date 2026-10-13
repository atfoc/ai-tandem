// A run of a section (a remote server of the server list) in the run's panes, beside
// logic/runserver.ts: what its bar's Stop and Resume take, the words of the delivery card that
// name the folder, and the runs a restart of this computer's server stops. DOM-free.
import { LOCAL_SERVER } from "../types.ts";
import type { Where } from "./chatserver.ts";
import { inSection } from "./keys.ts";
import { notConnected } from "./status.ts";

const remote = (w: Where) => w.server !== LOCAL_SERVER;

/** Why the bar's Stop and Resume take no click, as their title; "" when they do. */
export const runActBlock = (w: Where): string => (w.connected ? "" : notConnected(w.name));

/** "your folder" where the page speaks of the run's folder: another server's is not the person's own. */
export const yourFolder = (w: Where): string => (remote(w) ? `the folder on ${w.name}` : "your folder");

/** The delivery card's title ("Applied to your folder", "Already in your folder") by the run's server. */
export const deliveryTitle = (w: Where, title: string): string => (remote(w) ? title.replace("your folder", yourFolder(w)) : title);

/** The delivery card's button. */
export const applyLabel = (w: Where): string => (remote(w) ? `Apply to ${yourFolder(w)}` : "Apply to my folder");

/** The settings form's switch that applies the result at the run's end. */
export const applySetting = (w: Where): string => `Apply the result to ${remote(w) ? yourFolder(w) : "my folder"} when the run ends`;

/** The line above the command that takes the result by hand: it is run where the run's folder is. */
export const byHandLine = (w: Where): string =>
  (remote(w) ? `To take it into the branch ${yourFolder(w)} is on, run this on ${w.name}:` : "To take it into the branch you are on:");

/** The runs of this computer: a restart of its server stops none of a section. */
export const localRuns = <R extends { id: string }>(runs: Iterable<R>): R[] => [...runs].filter((r) => !inSection(r.id));
