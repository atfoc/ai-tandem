// What both board hosts do with their channel (AD-52): `createChannel` of the board side, with a count of the requests that
// wait for a reply, so a host that is to go away (the board screen is left: the board side asked the view for its scene
// first, to write it) lets the view answer before it ends. No React and no react-native here, so Node loads it.
import { createChannel, type BoardChannel, type Channel, type ChannelOptions } from "@aiwb/core/board/channel.ts";
import type { ToBoard } from "@aiwb/board-bridge/messages.ts";

import type { HostChannel } from "./board.types.ts";

/** The longest a host waits for requests in flight when it goes away (ms). */
export const DRAIN_LIMIT = 3000;

/** `base` with the count of its requests in flight. */
export function tracked(base: BoardChannel): HostChannel {
  let n = 0;
  let waiting: (() => void)[] = [];
  const done = () => {
    if (--n > 0) return;
    const w = waiting;
    waiting = [];
    for (const f of w) f();
  };
  return {
    send: (m) => base.send(m),
    request(op) {
      n++;
      const p = base.request(op);
      p.then(done, done);
      return p;
    },
    on: (l) => base.on(l),
    ready: () => base.ready(),
    inflight: () => n,
    idle: () => (n === 0 ? Promise.resolve() : new Promise<void>((r) => waiting.push(r))),
  };
}

export type HostLink = Channel & { channel: HostChannel };

/** The channel of one host: `post` takes what goes to the view, `receive` what comes from it. */
export function createHostChannel(post: (m: ToBoard) => void, options?: ChannelOptions): HostLink {
  const c = createChannel(post, options);
  return { ...c, channel: tracked(c.channel) };
}

/** Resolves when the channel has no request in flight, or after `limit` ms, whichever is first. */
export function drained(ch: HostChannel, limit = DRAIN_LIMIT): Promise<void> {
  return Promise.race([ch.idle(), new Promise<void>((r) => setTimeout(r, limit))]);
}
