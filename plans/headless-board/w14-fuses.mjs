// Reads the Electron fuse wire from the Electron Framework binary (sentinel + version + length + one byte per fuse: '0' off, '1' on, 'r' removed).
import fs from "node:fs";
const f = process.argv[2];
const buf = fs.readFileSync(f);
const i = buf.indexOf("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
if (i < 0) { console.log("no fuse sentinel"); process.exit(0); }
const p = i + 32; const ver = buf[p], len = buf[p + 1];
const names = ["RunAsNode", "EnableCookieEncryption", "EnableNodeOptionsEnvironmentVariable", "EnableNodeCliInspectArguments", "EnableEmbeddedAsarIntegrityValidation", "OnlyLoadAppFromAsar", "LoadBrowserProcessSpecificV8Snapshot", "GrantFileProtocolExtraPrivileges", "WasmTrapHandlers"];
console.log("fuse wire v" + ver, "length", len);
for (let k = 0; k < len; k++) console.log(" ", names[k] ?? "fuse" + k, String.fromCharCode(buf[p + 2 + k]));
