// A listener on 127.0.0.1 that the page is told to try to reach (probeNetwork). Every request it gets is a failure of
// the "no network" check: it appends one line per request to the file given and answers 200.
// Usage: node scripts/probe-server.mjs <port> <hits file>
import http from "node:http";
import fs from "node:fs";
const [port, file] = [Number(process.argv[2]), process.argv[3]];
fs.writeFileSync(file, "");
http.createServer((req, res) => { fs.appendFileSync(file, `${new Date().toISOString()} ${req.method} ${req.url}\n`); res.end("hit"); }).listen(port, "127.0.0.1");
