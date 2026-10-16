// A client of a scratch server's client API with no page and no stream: the calls a script makes on its own (a board made for
// nobody, a chat for the stand-in agent, a direct write with a page's client id) as the server sees them from any client: HTTPS to
// the client listener, the certificate accepted by its fingerprint and by nothing else, the secret, a client id and the level.
//
// A client with no stream is no client of the bridge: a board it makes is held by nobody (the server gives a made board to its
// maker only when the maker has a stream), and a take by it is refused. That is what makes it the way to have a free board.
import https from "node:https";
import crypto from "node:crypto";

export const LEVEL = "7";

// (no kept connection and no resumed session: the certificate of a resumed session is not seen again, and each call is pinned)
const agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });

export class RawClient {
  /** server: a Scratch (port, secret, fingerprint). clientId: the id the server sees; default a new one. */
  constructor(server, clientId = crypto.randomUUID()) {
    this.server = server;
    this.clientId = clientId;
  }

  /** { status, json, text, rev, headers } of one call. body: a value to send as JSON. */
  call(method, path, body) {
    const { port, secret, fingerprint } = this.server;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = https.request({
        host: "127.0.0.1", port, method, path, agent, rejectUnauthorized: false, timeout: 30000,
        headers: {
          "X-AIWB-Secret": secret, "X-AIWB-Client": this.clientId, "X-AIWB-Level": LEVEL,
          ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}),
        },
      }, (res) => {
        const pinned = res.socket.getPeerCertificate().fingerprint256;
        if (pinned !== fingerprint) { res.destroy(); reject(new Error(`certificate ${pinned} is not the pinned ${fingerprint}`)); return; }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
          const rev = res.headers["x-aiwb-scene-rev"];
          resolve({ status: res.statusCode, json, text, rev: rev === undefined ? null : Number(rev), headers: res.headers });
        });
      });
      req.on("timeout", () => req.destroy(new Error(`${method} ${path}: no answer in 30 s`)));
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  /** A board nobody holds; answers its view ({ id, name, ... }). */
  async newBoard(name) {
    const r = await this.call("POST", "/api/boards", { name, group: "__ungrouped__", new: true });
    if (r.status !== 200) throw new Error(`POST /api/boards: ${r.status} ${r.text}`);
    return r.json;
  }
  /** A chat on a board; answers its id. */
  async newChat(board) {
    const r = await this.call("POST", "/api/chats", { board });
    if (r.status !== 200) throw new Error(`POST /api/chats: ${r.status} ${r.text}`);
    return r.json.id;
  }
  async send(chat, text) {
    const r = await this.call("POST", `/api/chats/${chat}/messages`, { text });
    if (r.status !== 200) throw new Error(`POST messages: ${r.status} ${r.text}`);
    return r.json;
  }
  /** The texts of the chat's assistant messages so far (on the current branch). */
  async replies(chat) {
    const r = await this.call("GET", `/api/chats/${chat}/items`);
    if (r.status !== 200) throw new Error(`GET items: ${r.status} ${r.text}`);
    return (r.json.items ?? []).filter((i) => i.role === "assistant" || i.kind === "assistant").map((i) => i.text ?? i.content ?? "");
  }
  /** The stored scene and its revision. */
  async scene(board) {
    const r = await this.call("GET", `/api/boards/${board}/scene`);
    return { status: r.status, scene: r.json, rev: r.rev };
  }
}
