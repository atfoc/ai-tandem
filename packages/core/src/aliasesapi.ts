// The Claude accounts of a server (aliases on the board), as its client API gives them: TypeScript mirror of
// internal/aliases/api.go, field for field by json name. Every server answers the calls for its own accounts (the screen
// is per server), so each call names the server it goes to by its entry id (LOCAL_SERVER = this computer).
//
// The whole list comes in the server's snapshot (`aliases`) and again in an `aliases` event after every change of it
// (a record, a container, a login, a busy count, Docker's state). The login URL is only in the answer of the call that
// starts or joins the login, never in an event.
import { call } from "./api.ts";
import type { AgentKind } from "./types.ts";

/** The stream event that carries the whole list: { type: "aliases", aliases: AliasList }. */
export const ALIASES_EVENT = "aliases";

/** Why Docker cannot be used (DockerState.kind). */
export type DockerKind = "not_installed" | "not_running" | "unsupported" | "failed";

export type DockerState = { ok: boolean; kind?: DockerKind; reason?: string };

/** A login as Claude's own `auth status` last said it. known false: not asked yet, or it could not run (error says why). */
export type AliasLogin = { known: boolean; loggedIn: boolean; email?: string; error?: string; inFlight?: boolean };

export type ContainerState = "running" | "stopped" | "none" | "preparing" | "docker_unavailable" | "error";

export type ContainerView = { name: string; state: ContainerState; reason?: string };

/** What the account's existing container was made with; absent: no container yet. default: it was made for the default image
 *  (the account's image was ""), whatever tag of it that was. */
export type AliasApplied = { image: string; default?: boolean; mounts: string[] };

/** One account (aliases.View). */
export type Alias = {
  id: string;
  name: string;
  image?: string; // absent or "": the default image
  mounts: string[];
  applied?: AliasApplied;
  created: string;
  kind: AgentKind; // "claude:" + id
  login: AliasLogin;
  container: ContainerView;
  restartNeeded: boolean; // saved image or folders differ from the running container's
  pending: string[]; // the saved folders the running container lacks
  busy: number; // agents working in its container now
};

/** The accounts of a server (aliases.List). host: the computer's own Claude Code, the first row. */
export type AliasList = { docker: DockerState; defaultImage: string; host: AliasLogin; aliases: Alias[] };

/** The body of an add (name required) or an edit: a field left out keeps its value. */
export type AliasInput = { name?: string; mounts?: string[]; image?: string };

/** What a change that may need the container recreated or stopped did. busy: nothing was done, `busy` agents work in it:
 *  ask the person, then call restart / stop with force. */
export type RestartOutcome = "done" | "deferred" | "busy" | "unchanged";

export type AliasChange = { restart: RestartOutcome; busy?: number; alias: Alias };

/** preparing: the container is being made ready (its image built, minutes the first time); call login again once the `aliases`
 *  event shows it running, which joins the login and answers its URL. */
export type LoginState = "preparing" | "waiting" | "logged_in" | "failed";

/** The answer of a login's start and of a code. waiting: open url, wait for a code (error: the last code was refused). */
export type LoginAnswer = { state: LoginState; url?: string; email?: string; error?: string };

/** The codes of the refusals about accounts (the ApiError's code); their sentences are shown as they come. alias_restarting (409): a
 *  new run is refused while the account's container is recreated or stopped ("The account's container is restarting; try again in a
 *  moment"). alias_stopped (409): GET /api/usage/claude:<id> while the account's container is stopped ("Start the account to see its
 *  usage"). alias_preparing (409): a message or a start on an account whose container could not be made ready in the time a start
 *  may wait ("The account's container is being prepared; try again in a moment."); the preparation goes on. bad_image (400): the
 *  add/edit's image is not an image name (“<image>” is not an image name (like ubuntu:24.04 or …)), shown in the sheet. */
export type AliasCode = "not_mounted" | "mount_pending" | "alias_removed" | "docker_unavailable" | "alias_restarting" | "alias_stopped" | "alias_preparing"
  | "bad_folder" | "bad_name" | "bad_image" | "not_found";

const at = "/api/aliases";
const one = (id: string) => `${at}/${encodeURIComponent(id)}`;

export const aliasesApi = {
  list: (server: string) => call<AliasList>(server, "GET", at),
  add: (server: string, input: AliasInput & { name: string }) => call<Alias>(server, "POST", at, input),
  edit: (server: string, id: string, input: AliasInput) => call<AliasChange>(server, "PATCH", one(id), input),
  /** Stops and removes its container and deletes its folder (login, sessions, settings). Its chats stay, and cannot continue. */
  remove: (server: string, id: string) => call<Record<string, never>>(server, "DELETE", one(id)),
  restart: (server: string, id: string, force = false) => call<AliasChange>(server, "POST", `${one(id)}/restart`, { force }),
  stop: (server: string, id: string, force = false) => call<AliasChange>(server, "POST", `${one(id)}/stop`, { force }),
  /** Starts the container if needed and Claude's own login in it; a login already running is joined. */
  login: (server: string, id: string) => call<LoginAnswer>(server, "POST", `${one(id)}/login`),
  loginCode: (server: string, id: string, code: string) => call<LoginAnswer>(server, "POST", `${one(id)}/login/code`, { code }),
  cancelLogin: (server: string, id: string) => call<Record<string, never>>(server, "DELETE", `${one(id)}/login`),
  logout: (server: string, id: string) => call<Alias>(server, "POST", `${one(id)}/logout`),
};
