// The app's handles, taken out of the process environment.
//
// The Go adapter hands the extension its settings in AIWB_* variables. pi's
// shell commands (the bash tool, the RPC `bash` command) inherit process.env,
// so a variable left there is readable by any command the model runs: the
// chat's MCP token inside AIWB_MCP_CONFIG, the bridge socket and run handle,
// the path of the chat's folder inside the app's data folder. takeAppEnv reads
// them once and deletes them from the environment.
//
// The values must outlive this module: pi runs the extension's factory again
// in the same process on a fork, clone, new session, resume or reload, and it
// imports extensions with the module cache off, so module-level state is not
// safe either. An evaluation that found no bridge variables would wire no
// permission gate (the standalone behaviour), and the chat would run without
// the app-folder guard. So the values live in one object on globalThis under a
// Symbol.for key, filled on the first read and used whenever a variable is
// absent.
//
// Dependency-free, so it is unit-testable with
// `node --test --experimental-strip-types` and no pi or node_modules.

/** The variables taken out of the environment. The other AIWB_* variables
 *  (chat id, pi path, model, thinking level, subagent identity) carry no
 *  handle to the app and stay. */
export const APP_ENV_NAMES = [
  "AIWB_BRIDGE_SOCKET",
  "AIWB_BRIDGE_RUN",
  "AIWB_MCP_CONFIG",
  "AIWB_CHAT_DIR",
  "AIWB_APPEND_PROMPT",
] as const;

/** The kept values; a variable that was never set is absent. */
export type AppEnv = Partial<Record<(typeof APP_ENV_NAMES)[number], string>>;

const STORE_KEY = Symbol.for("ai-whiteboard.pi-extension.app-env");

/**
 * takeAppEnv moves the app's variables from env into the store and returns the
 * kept values. A variable present in env replaces the kept value; an absent one
 * leaves it, so a second evaluation in the same process gets what the first
 * one read. With no variables at all it returns an empty object.
 */
export function takeAppEnv(
  env: Record<string, string | undefined> = process.env,
  store: Record<symbol, unknown> = globalThis as Record<symbol, unknown>,
): AppEnv {
  let kept = store[STORE_KEY] as AppEnv | undefined;
  if (!kept) {
    kept = {};
    store[STORE_KEY] = kept;
  }
  for (const name of APP_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined) kept[name] = value;
    delete env[name];
  }
  return kept;
}
