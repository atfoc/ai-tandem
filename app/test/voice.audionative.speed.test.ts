// The native player and the playback speed (small-improvements 6.1, 4.3): the port over the aiwb-audio module's fake is given what the speaker
// writes at 0.5×, 1.5× and 2× (the stretch of a tone in uneven chunks, a mark before each sentence). The port looks inside nothing: the module gets
// the very bytes, in the same writes, with the marks in their places, and the same assertion on the audio holds as for the engine and the web player.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createFakeAiwbAudio } from "../modules/aiwb-audio/src/fake.ts";
import { audioOver } from "../src/voice/platform/audio.native.ts";
import type { PlayerEvent } from "../src/voice/ports.ts";
import { assertStretched, chunked, fromBytes, stretchedWrites, toBytes, tone } from "./helpers/audiotest.ts";

const RATE = 24000;
const HZ = 220;
const SENTENCES = [tone(HZ, 1.5, RATE), tone(HZ, 1.4, RATE), tone(HZ, 1.3, RATE)];
const SIZES = [[4800, 998, 9600, 2], [3000, 480, 7000], [12000, 6, 4800]];

for (const speed of [0.5, 1.5, 2]) {
  test(`the native port at ${speed}×: the module gets the stretched bytes as written, the marks in their places`, async () => {
    const fake = createFakeAiwbAudio();
    const port = audioOver(fake.module);
    const events: PlayerEvent[] = [];
    port.player.on((e) => events.push(e));

    const writes: Uint8Array[][] = SENTENCES.map((s, i) => stretchedWrites(speed, RATE, chunked(toBytes(s), SIZES[i]!)));
    writes.forEach((sentence, i) => {
      port.player.mark(i + 1);
      for (const w of sentence) port.player.write(w);
    });

    // the module's calls: mark 1, the writes of sentence 1, mark 2, ... (after its set-up)
    const wanted = writes.flatMap((sentence, i) => [`playerMark:${i + 1}`, ...sentence.map(() => "playerWrite")]);
    assert.deepEqual(fake.calls.filter((c) => c.startsWith("player")), wanted);

    // byte for byte what was written
    const sent = writes.flat();
    const queued = fake.queued.filter((q) => q.kind === "pcm");
    assert.equal(queued.length, sent.length);
    queued.forEach((q, i) => assert.ok(q.kind === "pcm" && Buffer.compare(q.bytes, sent[i]!) === 0, `write ${i}`));
    const all = Uint8Array.from(sent.flatMap((w) => [...w]));
    assert.deepEqual(Uint8Array.from(fake.written), all);

    assertStretched(fromBytes(Uint8Array.from(fake.written)), {
      speed, inputSamples: SENTENCES.map((s) => s.length), hz: HZ, label: `native player ${speed}×`,
    });

    // the device plays the queue: the marks come in order, then the drain
    fake.play();
    assert.deepEqual(events.filter((e) => e.kind === "mark").map((e) => (e as { id: number }).id), [1, 2, 3]);
    assert.equal(events.at(-1)!.kind, "drained");
  });
}
