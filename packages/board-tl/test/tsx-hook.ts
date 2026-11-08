// Lets a test import `.tsx` modules (the shape utils with their React parts): Node strips types from `.ts` itself, but not
// from `.tsx`; esbuild turns those into plain modules (JSX automatic, as the builds do).
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

registerHooks({
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".tsx")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const { code } = transformSync(source, { loader: "tsx", jsx: "automatic", format: "esm", sourcefile: fileURLToPath(url) });
    return { format: "module", source: code, shortCircuit: true };
  },
});
