// An answer, an event or an exception as a voice problem (architecture §2.6 and §12). It reads the status and the codes of an answer's body
// and the type of a socket's error, and nothing else: no URL, no header and no message text, so a problem can never carry the key.
import { VoiceProblemError } from "../ports.ts";
import type { VoiceProblemKind } from "../ports.ts";

const CREDIT_CODES = new Set(["quota_exceeded", "insufficient_credits"]);

/** The `detail.code`, else the `detail.status`, of an error body (`{"detail": {...}}`); "" when the body has neither. */
function codeOf(bodyText: string): string {
  let v: unknown;
  try { v = JSON.parse(bodyText); } catch { return ""; }
  const detail = typeof v === "object" && v !== null ? (v as Record<string, unknown>).detail : null;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return "";
  const d = detail as Record<string, unknown>;
  return typeof d.code === "string" ? d.code : typeof d.status === "string" ? d.status : "";
}

/** The problem an HTTP answer is, or null for one that went through (2xx and 3xx). */
export function problemOfStatus(status: number, bodyText: string): VoiceProblemKind | null {
  if (status < 400) return null;
  if (CREDIT_CODES.has(codeOf(bodyText))) return "no_credits";
  if (status === 401 || status === 403) return "key_rejected";
  if (status === 402 || status === 429) return "no_credits";
  if (status === 408 || status >= 500) return "offline";
  return "service";
}

/** The problem a message type of the STT socket is, or null for the two after which the listener opens the socket again (VC-19). */
export function problemOfSttError(type: string): VoiceProblemKind | null {
  switch (type) {
    case "auth_error":
      return "key_rejected";
    case "quota_exceeded":
    case "rate_limited":
    case "commit_throttled":
    case "queue_overflow":
    case "resource_exhausted":
      return "no_credits";
    case "unaccepted_terms":
      return "service";
    case "session_time_limit_exceeded":
    case "insufficient_audio_activity":
      return null;
    default:
      return "offline";
  }
}

/** The problem a failed call is: a problem a port already named stays that one, anything else (a `VoiceNetError`, a timeout, a cut
 *  socket, something unknown) is that the service can't be reached. */
export function problemOfException(e: unknown): VoiceProblemKind {
  if (e instanceof VoiceProblemError) return e.kind;
  return "offline";
}
