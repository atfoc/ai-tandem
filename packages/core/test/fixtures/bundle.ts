// What the tests that bundle core's state layer with esbuild need: the alias of @aiwb/core, the place a module has in
// src/ (which their stubs are named by), the kv port of the tests (a stand-in for the page's localStorage), and the text
// of core's sources for the tests that read them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const coreSrc = path.resolve(here, "../../src");
export const alias = { "@aiwb/core": coreSrc };
/** The kv port over the test's `globalThis.localStorage`, as the page's was (an esbuild entry names it by this path). */
export const kvFile = path.join(here, "kv.ts");

/** Where an import of the bundle is in core's src/ ("api.ts", "logic/drafts.ts", "state/actions.ts"); null for a package. */
export function inSrc(src: string, a: { path: string; resolveDir: string }): string | null {
  if (a.path.startsWith("@aiwb/core/")) return a.path.slice("@aiwb/core/".length);
  if (!a.path.startsWith(".")) return null;
  const at = path.resolve(a.resolveDir, a.path);
  return path.relative(at.startsWith(coreSrc + path.sep) ? coreSrc : src, at);
}

/** The text of a source file of core ("api.ts", "logic/keys.ts", "state/conn.ts"). */
export const sourceOf = (f: string): string => fs.readFileSync(path.join(coreSrc, f), "utf8");

/** Every file of core's src/, relative to it. */
export function sourceNames(): string[] {
  return (fs.readdirSync(coreSrc, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(coreSrc, f)).isFile());
}
