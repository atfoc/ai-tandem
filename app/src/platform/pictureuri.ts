// What <Picture> on a phone draws (AD-36 point 3): RN's <Image> is given only `file://` addresses, those of the picture
// cache (AD-25) and of the files the picker made; an address of any other scheme (`http:`, `https:`, `data:`, `content:`,
// a relative path) is the broken tile, so that no <Image> ever opens a connection of its own.

/** True for an address RN's <Image> may be given. */
export function isFileUri(uri: string): boolean {
  return /^file:\/\//i.test(uri);
}
