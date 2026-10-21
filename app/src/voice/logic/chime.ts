// The sound of Test speaker (voice-devices architecture VD-15): made by the app, so the test needs no sound file, no request and no key.
// A 0.6 s chime of two notes, 660 Hz then 880 Hz, as speech is played: 24 kHz mono s16le, 10 ms fades at the start and the end of each note
// (no click), the loudest sample at -12 dBFS.

const RATE = 24_000;
const NOTE_S = 0.3;
const FADE_S = 0.01;
const NOTES_HZ: readonly number[] = [660, 880];
const PEAK_DBFS = -12;

/** The chime as PCM s16le at 24 kHz: a new array at every call. */
export function chimePcm(): Uint8Array {
  const per = Math.round(RATE * NOTE_S);
  const fade = Math.round(RATE * FADE_S);
  const floats = new Float64Array(per * NOTES_HZ.length);
  NOTES_HZ.forEach((hz, n) => {
    for (let i = 0; i < per; i++) {
      const edge = Math.min(i, per - 1 - i);
      const gain = edge >= fade ? 1 : (edge + 1) / (fade + 1);
      floats[n * per + i] = Math.sin((2 * Math.PI * hz * i) / RATE) * gain;
    }
  });
  let loudest = 0;
  for (const f of floats) loudest = Math.max(loudest, Math.abs(f));
  const top = Math.round(10 ** (PEAK_DBFS / 20) * 32767);
  const bytes = new Uint8Array(floats.length * 2);
  const view = new DataView(bytes.buffer);
  floats.forEach((f, i) => view.setInt16(i * 2, Math.round((f / loudest) * top), true));
  return bytes;
}
