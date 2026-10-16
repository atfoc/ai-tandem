// Exits 0 when Electron's RunAsNode fuse is on in the given app (or Electron binary), 1 with a message when it is off or cannot
// be read. The server runs the headless writer with the app's own Electron as Node (ELECTRON_RUN_AS_NODE=1), which that fuse allows.
//   node scripts/check-run-as-node.mjs "bin/AI Whiteboard.app"
// Reads the fuse wire with @electron/fuses, which electron-builder brings into desktop/node_modules.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = process.argv[2];
if (!app) { console.error("usage: node scripts/check-run-as-node.mjs <app or Electron binary>"); process.exit(2); }
const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "package.json"));
const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");
try {
  const wire = await getCurrentFuseWire(app);
  if (wire[FuseV1Options.RunAsNode] === 0x31) process.exit(0); // (the wire holds ASCII: '1' on, '0' off, 'r' removed)
  console.error(`the RunAsNode fuse of Electron is off in ${app}: the server could not run the headless writer with the app's Electron as Node (ELECTRON_RUN_AS_NODE has no effect). Do not flip it off in desktop/electron-builder.yml or in an afterPack hook.`);
} catch (e) {
  console.error(`cannot read the RunAsNode fuse of ${app}: ${e.message}`);
}
process.exit(1);
