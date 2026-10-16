// The module `packages/headless` imports (architecture.md section 4, engine.md section 2): the board view's endpoint, in Node, for the
// requests on given elements.
//
//   createNodeEndpoint(post, { assets })   starts the engine from the assets folder and posts `ready`
//   ENGINE_EXTERNALS                       the module names the headless build must leave out of its bundle
//   copyEngineAssets(dir, target)          writes the assets folder: engine.mjs, fonts/, node_modules/skia-canvas/
//
// This file is bundled into the headless writer, so it imports nothing heavy: the engine itself (Excalidraw, the stand-in page, the
// board view's code) is `<assets>/engine.mjs`, imported at run time; the build tooling (esbuild) is imported only by `copyEngineAssets`.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { FromBoard, ToBoard } from "@aiwb/board-bridge/messages.ts";
import { binaryProblem, fetchSkiaBinary, skiaPackage, type Target } from "./skia-binary.ts";

export type NodeEndpointOptions = {
  /** The folder of the engine's files inside the headless bundle (fonts, the native canvas, …): `<bundle dir>/engine`. */
  assets: string;
  /** What `ready` tells as its version. Default: `excalidraw <version>; skia-canvas <version>`. */
  version?: string;
  /** Where the engine logs a line; never board content. Default: stderr. */
  warn?: (text: string) => void;
};

export type NodeEndpoint = {
  /** A message of the app, already validated. A `req` is answered with one `res` through `post`; every other message is ignored. */
  receive(m: ToBoard): void;
  /** A message that failed validation: logged; a `req` among them is answered `res ok:false code BAD_MESSAGE`. */
  refuse(raw: unknown, error: string): void;
  /** Frees what the engine holds (the canvas): nothing is posted after it. */
  close(): Promise<void>;
};

/** The modules the headless build leaves out of its bundle: the native canvas is loaded from `<assets>/node_modules`. */
export const ENGINE_EXTERNALS: string[] = ["skia-canvas"];

/** The families of Excalidraw's fonts that the assets hold (Xiaolai, 12 MB of Chinese fonts, is not shipped). */
const FONT_FAMILIES = ["Assistant", "Cascadia", "ComicShanns", "Excalifont", "Liberation", "Lilita", "Nunito", "Virgil"];
const BINARY = path.join("node_modules", "skia-canvas", "lib", "skia.node");

type EngineModule = {
  excalidrawVersion: string;
  createGivenEndpoint(post: (m: FromBoard) => void, o: { version: string; warn: (text: string) => void }): Pick<NodeEndpoint, "receive" | "refuse">;
};

/** The first thing missing from an assets folder, in words, or null. */
function missingIn(assets: string): string | null {
  if (!fs.existsSync(assets)) return `the engine's folder ${assets} does not exist`;
  if (!fs.existsSync(path.join(assets, "engine.mjs"))) return `engine.mjs is missing from ${assets}`;
  if (!fs.existsSync(path.join(assets, BINARY))) return `the native canvas ${BINARY} is missing from ${assets}`;
  for (const f of FONT_FAMILIES) {
    const dir = path.join(assets, "fonts", f);
    if (!fs.existsSync(dir) || !fs.readdirSync(dir).length) return `the font folder fonts/${f} is missing from ${assets}`;
  }
  return null;
}

/** Starts the engine; resolves once it can work, after posting `{ t: "ready", version }` once. Rejects, posting nothing, with an
 *  Error whose message says why it cannot run here (what is missing from the assets, or the loader's own reason). */
export async function createNodeEndpoint(post: (m: FromBoard) => void, options: NodeEndpointOptions): Promise<NodeEndpoint> {
  const assets = path.resolve(options.assets);
  const warn = options.warn ?? ((t: string) => { process.stderr.write(`${t}\n`); });
  const missing = missingIn(assets);
  if (missing) throw new Error(missing);
  let engine: EngineModule;
  try {
    engine = (await import(pathToFileURL(path.join(assets, "engine.mjs")).href)) as EngineModule;
  } catch (e) {
    throw new Error(`${(e as Error)?.message ?? String(e)}`, { cause: e });
  }
  let closed = false;
  const version = options.version ?? `excalidraw ${engine.excalidrawVersion}; skia-canvas ${skiaVersion(assets)}`;
  const given = engine.createGivenEndpoint((m) => { if (!closed) post(m); }, { version, warn });
  return {
    receive: (m) => { if (!closed) given.receive(m); },
    refuse: (raw, error) => { if (!closed) given.refuse(raw, error); },
    close: async () => { closed = true; },
  };
}

function skiaVersion(assets: string): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(assets, "node_modules", "skia-canvas", "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

// ---- build time: what copyEngineAssets writes

/** Writes the assets folder for one target into `dir`: `engine.mjs` (built if dist/engine.mjs is missing or older than its sources),
 *  `fonts/` and `node_modules/skia-canvas/` with the target's native binary as `lib/skia.node`. This machine's own target is copied
 *  from what is installed; another target's binary is fetched from its npm package (cached under the system temp folder) and checked. */
export async function copyEngineAssets(dir: string, target: Target): Promise<void> {
  // (a computed address: the headless build bundles this file and must not follow the import into esbuild)
  const { buildEngine, packageRoot } = (await import(new URL("../build.mjs", import.meta.url).href)) as typeof import("../build.mjs");
  const engineFile = await buildEngine({ ifStale: true });

  // the binary first: nothing is written for a target that has none
  const skiaRoot = packageRoot("skia-canvas");
  let binary: string;
  if (target.os === process.platform && target.arch === process.arch) {
    const pkg = skiaPackage(target);
    try {
      binary = createRequire(path.join(skiaRoot, "package.json")).resolve(pkg);
    } catch (e) {
      throw new Error(`copyEngineAssets: the native canvas ${pkg} is not installed`, { cause: e });
    }
    const problem = binaryProblem(binary, target);
    if (problem) throw new Error(`copyEngineAssets: ${problem}`);
  } else {
    binary = await fetchSkiaBinary(target);
  }

  const out = path.resolve(dir);
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(engineFile, path.join(out, "engine.mjs"));

  const fontsDir = path.join(packageRoot("@excalidraw/excalidraw"), "dist", "prod", "fonts");
  fs.rmSync(path.join(out, "fonts"), { recursive: true, force: true });
  for (const d of fs.readdirSync(fontsDir)) {
    if (d !== "Xiaolai") fs.cpSync(path.join(fontsDir, d), path.join(out, "fonts", d), { recursive: true });
  }

  // skia-canvas's JavaScript (not its tests, its downloader or its dependencies: those serve downloads and error texts only)
  const dest = path.join(out, "node_modules", "skia-canvas");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, "lib"), { recursive: true });
  for (const f of ["package.json", "LICENSE"]) fs.copyFileSync(path.join(skiaRoot, f), path.join(dest, f));
  for (const sub of ["", "classes"]) {
    const from = path.join(skiaRoot, "lib", sub);
    fs.mkdirSync(path.join(dest, "lib", sub), { recursive: true });
    for (const n of fs.readdirSync(from)) {
      if (/\.(js|mjs|ts)$/.test(n) && n !== "prebuild.mjs") fs.copyFileSync(path.join(from, n), path.join(dest, "lib", sub, n));
    }
  }
  fs.cpSync(path.join(skiaRoot, "lib", "fonts"), path.join(dest, "lib", "fonts"), { recursive: true });
  // (copy-on-write where the file system has it: the binary is 28-39 MB)
  fs.copyFileSync(binary, path.join(dest, "lib", "skia.node"), fs.constants.COPYFILE_FICLONE);
}
