// A run on another server (an entry of the server list) in the sidebar and in the run's panes,
// beside logic/runserver.ts: its row, what its bar's Stop and Resume take, the words of the
// delivery card that name the folder, and the runs a restart of this computer's server stops.
// DOM-free.
import { LOCAL_SERVER, type RunView } from "../types.ts";
import type { Where } from "./chatserver.ts";
import { runDot, runRowLine } from "./run.ts";
import { notConnected, remoteRow } from "./status.ts";

const remote = (w: Where) => w.server !== LOCAL_SERVER;

type Dot = NonNullable<ReturnType<typeof runDot>>;
export type RunRow = { line: string; dot: Dot | "off" | null; off: boolean; gone: boolean; title: string };

/** A run's sidebar row (remoteRow, status.ts, over runRowLine and runDot): the server's name
 *  follows the line; grey and `off` while that server is not connected; a run its server no
 *  longer has (gone) says that alone. A run of this computer is as it was: a dot only for the
 *  statuses runDot marks. */
export function runRow(r: Parameters<typeof runRowLine>[0] & Pick<RunView, "server" | "gone">, name: string, connected: boolean): RunRow {
  const row = remoteRow(r, name, connected, runRowLine(r), runDot(r) ?? "");
  return { ...row, dot: row.dot || null };
}

/** The row's tooltip: what the row itself says of its server ("<Name> is not connected", "No
 *  longer on <Name>"), else where the run is, its name and its line (runRowTitle, siderun.ts). */
export const runRowTip = (r: Pick<RunView, "name">, path: string[], row: Pick<RunRow, "line" | "title">): string =>
  row.title || `${[...path, r.name].join(" / ")} — ${row.line}`;

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

/** The runs of this computer: a restart of its server stops none on another. */
export const localRuns = <R extends { server?: string }>(runs: Iterable<R>): R[] => [...runs].filter((r) => !r.server);
