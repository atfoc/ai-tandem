// The one place an address of the voice service is made (architecture VC-6). Every caller gives a path and a query, never a host: the
// host is the service's own, or (in a development build only) a stand-in on this computer or the local network, so a key in a header
// cannot be sent anywhere else. The scheme words are built here from `https`/`wss`; no other file of voice writes an address.

export const VOICE_HTTP = "https://api.elevenlabs.io";
export const VOICE_WS = "wss://api.elevenlabs.io";

export type VoiceBase = { http: string; ws: string };
const SERVICE: VoiceBase = { http: VOICE_HTTP, ws: VOICE_WS };

const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const ADDRESS = new RegExp(`^(https?)://([A-Za-z0-9.-]{1,253})(?::([0-9]{1,5}))?((?:/[A-Za-z0-9_-]{1,64}){0,4})/?$`);
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

/** Whether a host is one the stand-in may be on: this computer, the Android emulator's alias of it, or a private IPv4 address. */
export function isLocalHost(host: string): boolean {
  if (host === "localhost" || host === "10.0.2.2") return true;
  if (!IPV4.test(host)) return false;
  const [a, b] = host.split(".").map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** `scheme://host[:port]` of an address with no user, query or fragment, whose host passes `isLocalHost`, and the plain path it may
 *  carry (`/voice`: words only, no `..` or `//`), which only the build's override uses; else null. */
function localAddress(value: string | undefined): { origin: string; path: string } | null {
  const m = value ? ADDRESS.exec(value.trim()) : null;
  if (!m || !isLocalHost(m[2])) return null;
  if (m[3] !== undefined && Number(m[3]) > 65535) return null;
  return { origin: `${m[1]}://${m[2]}${m[3] === undefined ? "" : `:${m[3]}`}`, path: m[4] ?? "" };
}

/** `localAddress` of a value that has no path (a page's origin); else null. */
function localOrigin(value: string | undefined): { origin: string } | null {
  const a = localAddress(value);
  return a && a.path === "" ? a : null;
}

/** The base of the stand-in named by a build's `EXPO_PUBLIC_AIWB_VOICE_BASE`, or the service's own. The override counts only in a
 *  development build (`dev`) and only for a local host (`isLocalHost`), with or without a plain path (`http://127.0.0.1:4750/voice`); a
 *  Release build, a public host or a malformed value is ignored. */
export function voiceBase(override: string | undefined, dev: boolean): VoiceBase {
  const local = dev ? localAddress(override) : null;
  if (!local) return SERVICE;
  const http = local.origin + local.path;
  return { http, ws: http.replace(/^http/, "ws") };
}

const PATH = /^\/[A-Za-z0-9_\-./]*$/;

/** An address from a base, a path ("/v1/…") and a query. A path that is not plain ("//host", "..", a query or fragment in it) is refused. */
function build(base: VoiceBase, kind: "http" | "ws", path: string, query: Record<string, string>): string {
  if (!PATH.test(path) || path.startsWith("//") || path.includes("..")) throw new Error("voice: not a path of the voice service");
  const pairs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return `${kind === "http" ? base.http : base.ws}${path}${pairs.length ? `?${pairs.join("&")}` : ""}`;
}

/** `voiceURL` of a build whose override and mode are given (the tests' way in). */
export function makeVoiceURL(override: string | undefined, dev: boolean) {
  const base = voiceBase(override, dev);
  return (kind: "http" | "ws", path: string, query: Record<string, string>): string => build(base, kind, path, query);
}

/** The address of the voice service on a phone: the service, or the build's stand-in (VC-6). Metro puts the variable in at bundle time. */
export const voiceURL = makeVoiceURL(process.env.EXPO_PUBLIC_AIWB_VOICE_BASE, (globalThis as { __DEV__?: boolean }).__DEV__ === true);

/** The web build's page-direct base: the stand-in the test host or the mock serves under `/voice` on the page's own origin. Only for an
 *  origin on this computer or the local network (a page served from a public host never sends a key there); else null. */
export function pageVoiceBase(origin: string | undefined): VoiceBase | null {
  const local = localOrigin(origin);
  return local ? { http: `${local.origin}/voice`, ws: `${local.origin.replace(/^http/, "ws")}/voice` } : null;
}

/** An address of the stand-in on the page's own origin; throws when the origin is not a local one. */
export function pageVoiceURL(origin: string | undefined, kind: "http" | "ws", path: string, query: Record<string, string>): string {
  const base = pageVoiceBase(origin);
  if (!base) throw new Error("voice: this page has no voice service of its own");
  return build(base, kind, path, query);
}
