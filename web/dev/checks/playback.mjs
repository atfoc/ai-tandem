// The playback spy of the speed check (VC.9; no dash in the name, the runner does not take it for a check). `installPlayback(page | context)` puts it into
// every page before the app loads (`addInitScript`). It patches the prototypes of `AudioBufferSourceNode` (start, stop), so it does not matter in which
// order it and devices.mjs (which replaces `AudioContext` by a subclass) were installed, or which `AudioContext` the page makes: the player of voice is
// the context at 24 kHz (audio.web.ts PLAYER_RATE), and only the sources of such a context are recorded (the microphone's context runs at the
// device's rate and plays nothing). No sound is changed; the data of a buffer is read, never written.
//
// What the check sees, `window.__aiwbPlayback` (every value is plain data, so page.evaluate returns it):
//   sources()     every source started on the player's context since the last reset, in the order of `start`:
//                   { when, duration, samples, hz, stoppedAt, calledAt, calledDate }
//                 when        the ctx time the source was scheduled for (`start(when)`)
//                 duration    seconds (samples / 24000)
//                 samples     the length of its buffer
//                 hz          the frequency of the data by its zero crossings (rising ones, the first and last placed by linear interpolation), null when
//                             the buffer holds fewer than three of them
//                 stoppedAt   ctx.currentTime at `stop()`, null when it was not stopped
//                 calledAt    ctx.currentTime at the call of `start`; calledDate: `Date.now()` at that call (so that the moment the sound begins,
//                             calledDate + (when - calledAt) * 1000, can be compared with the clock of the stand-in voice service)
//   now()         the player context's `currentTime` (null before the page made one)
//   reset()       forgets the sources, the texts and the presses
//   watchText(testId)   from now on, each change of the text of the element with that `data-testid` (the first one in the document) is a record
//                 { text, at } with at = ctx.currentTime ("" when the element is gone), or null while there is no player context. A MutationObserver,
//                 so a record is made within a task of the change
//   texts(testId?)      the records, of one id or of all (each with its testId)
//   watchPress(testId)  from now on, a pointerup or a click on that element (or inside it) is a record { testId, type, at }
//   presses()           the records

/** Installs the spy in a page or a browser context; call it before the page goes to the app. */
export async function installPlayback(target) {
  await target.addInitScript(playbackLayer);
}

/** The page's side. Serialised and run in the page, so it names nothing outside itself. */
export function playbackLayer(g = globalThis) {
  if (g.__aiwbPlayback) return;
  const PLAYER_RATE = 24000;
  const recs = new WeakMap();
  let sources = [];
  let texts = [];
  let presses = [];
  let player = null;

  const isPlayer = (ctx) => !!ctx && ctx.sampleRate === PLAYER_RATE;
  const clock = () => (player ? player.currentTime : null);

  /** The frequency by the rising zero crossings, the first and last placed between their samples. */
  const hzOf = (data, rate) => {
    const at = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i - 1] < 0 && data[i] >= 0) at.push(i - 1 + -data[i - 1] / (data[i] - data[i - 1]));
    }
    if (at.length < 3) return null;
    return ((at.length - 1) / (at[at.length - 1] - at[0])) * rate;
  };

  const SourceNode = g.AudioBufferSourceNode;
  if (SourceNode) {
    const start = SourceNode.prototype.start;
    const stop = SourceNode.prototype.stop;
    SourceNode.prototype.start = function spyStart(when, ...rest) {
      const ctx = this.context;
      if (isPlayer(ctx) && this.buffer && !recs.has(this)) {
        player = ctx;
        const buffer = this.buffer;
        const rec = {
          when: typeof when === "number" ? when : ctx.currentTime,
          duration: buffer.duration,
          samples: buffer.length,
          hz: hzOf(buffer.getChannelData(0), buffer.sampleRate),
          stoppedAt: null,
          calledAt: ctx.currentTime,
          calledDate: Date.now(),
        };
        recs.set(this, rec);
        sources.push(rec);
      }
      return start.call(this, when, ...rest);
    };
    SourceNode.prototype.stop = function spyStop(...args) {
      const rec = recs.get(this);
      if (rec && rec.stoppedAt === null) rec.stoppedAt = this.context.currentTime;
      return stop.apply(this, args);
    };
  }

  // ---- the texts
  const watched = new Map();   // testId -> the last text seen
  let observer = null;
  const look = () => {
    for (const [testId, last] of watched) {
      const el = g.document.querySelector(`[data-testid="${testId}"]`);
      const text = el ? (el.textContent ?? "") : "";
      if (text !== last) {
        watched.set(testId, text);
        texts.push({ testId, text, at: clock() });
      }
    }
  };

  // ---- the presses
  const pressed = new Set();
  const onEvent = (e) => {
    const t = e.target instanceof g.Element ? e.target : null;
    if (!t) return;
    for (const testId of pressed) if (t.closest(`[data-testid="${testId}"]`)) presses.push({ testId, type: e.type, at: clock() });
  };
  let listening = false;

  g.__aiwbPlayback = {
    sources: () => sources.map((s) => ({ ...s })),
    now: clock,
    reset() { sources = []; texts = []; presses = []; },
    watchText(testId) {
      if (!watched.has(testId)) {
        const el = g.document.querySelector(`[data-testid="${testId}"]`);
        watched.set(testId, el ? (el.textContent ?? "") : "");
      }
      if (!observer) {
        observer = new g.MutationObserver(look);
        observer.observe(g.document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-testid"] });
      }
    },
    texts: (testId) => texts.filter((t) => testId === undefined || t.testId === testId).map((t) => ({ ...t })),
    watchPress(testId) {
      pressed.add(testId);
      if (!listening) {
        listening = true;
        for (const type of ["pointerup", "click"]) g.document.addEventListener(type, onEvent, true);
      }
    },
    presses: () => presses.map((p) => ({ ...p })),
  };
}
