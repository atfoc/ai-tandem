// The last tree Home drew of each server (ux-improvements goal 3.2, package H1; plans/ux-improvements/h1-design.md §5). The store drops a remote
// server's tree when it leaves `connected`; Home and a group's screen keep, in memory only, the last input they listed while the server was
// connected and draw that copy faded while it is away. Nothing is saved: after a restart a server that is down shows its card alone.
import type { PlaceInput } from "./model.ts";

const last = new Map<string, PlaceInput>();

/** Keeps `input` as the server's last tree. Called while the server is connected and its tree is held. */
export function rememberPlace(server: string, input: PlaceInput): void {
  last.set(server, input);
}

/** The server's last tree, or none when this run never saw it connected. */
export const lastPlace = (server: string): PlaceInput | undefined => last.get(server);
