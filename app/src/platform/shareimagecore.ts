// What both targets of the share port need: the bytes of a base64 PNG and a file name made from a board's name. No react-native, so Node loads it.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The bytes of a base64 text (no `atob` and no `Buffer`: the same on every platform); characters outside the alphabet are skipped. */
export function fromBase64(text: string): Uint8Array {
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const ch of text) {
    const v = B64.indexOf(ch);
    if (v < 0) continue; // ("=" padding, a line break)
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); acc &= (1 << bits) - 1; }
  }
  return Uint8Array.from(out);
}

/** A file name (no extension) for a board's picture: its name with what a file system refuses turned into spaces. */
export function pictureName(board: string): string {
  const n = board.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return n || "board";
}
