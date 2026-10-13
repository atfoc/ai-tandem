// A chat of a section (a remote server of the server list), as the page sees it from the moment it
// is made: its first message (an ordinary Send), a server that is not connected, and a Send or a
// draft save that did not get through. The chat is named by its key on the page, "<entry id>~<id>"
// (src/logic/keys.ts), and by the entry and its own id on the wire: /api/on/<entry id>/chats/<id>.
// The rules are the logic's (src/logic/chatserver.ts, sendend.ts, status.ts, drafts.ts); the
// composer's steps around its saver are taken here as Composer.tsx's submit takes them, over a
// real DraftSaver, and the components are read as source (the unit tests have no DOM). The events
// through the real event layer are in conn.test.ts.
//
// Its images too: the composer of a section's chat makes the calls of a local chat for them, takes
// none while the chat's server is not connected, and the draft carries them through every step
// taken here: a save that fails while the server is away, a Send that fails or whose arrival is
// not known, two clients in one draft. The server each saver talks to takes a draft of images
// alone as a draft, as the real ones do. The same through the page's event layer, store and
// uploads is in keptpage.test.ts.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { api, ApiError } from "../src/api.ts";
import { agentOpen, pickAgent } from "../src/logic/agentlist.ts";
import { agentChoiceOn, boxOff, emptyReason, offPlaceholder, sendOff, sendTitleOn, showsServer, toolbarLine, notConnectedLine, type Where } from "../src/logic/chatserver.ts";
import { goneLine, imageUrl, imagesHold, imagesOff, uploadFailed, withImages, withoutImages } from "../src/logic/chatimage.ts";
import { DraftSaver, chatHasDraft, hasDraft, otherDrafts, type Unsaved } from "../src/logic/drafts.ts";
import { pickerMode } from "../src/logic/models.ts";
import { putsBack, refusalShown, sentNothing, underComposer } from "../src/logic/sendend.ts";
import { serverFixed, SERVER_FINAL } from "../src/logic/serverlists.ts";
import { refreshAfterRefusal } from "../src/logic/status.ts";
import { subChip } from "../src/logic/subsettings.ts";
import { LOCAL_SERVER, type ChatImage, type ChatView, type Draft } from "../src/types.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const composer = src("Composer.tsx");
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

const HERE: Where = { server: LOCAL_SERVER, name: "This computer", connected: true };
/** An entry of the server list, and the page's key of the chat c_1 of its section. */
const S1 = "s_aaaaaaaaaaaa", K = `${S1}~c_1`;
/** Where the local server answers for that chat: the call of a local chat, under the entry. */
const ON = `/api/on/${S1}/chats/c_1`;
const THERE: Where = { server: S1, name: "Studio", connected: true };
const DOWN: Where = { ...THERE, connected: false };
const chat = (o: Partial<ChatView> = {}) => ({ id: "c_1", agent: "claude", status: "ready", locked: false, cwd: "/w", model: "m", ...o }) as ChatView;
/** An unstarted chat of the section: on that server from the moment it is made. */
const NEW = chat({ id: K });
/** The same once it has had a message. */
const STARTED = chat({ id: K, locked: true });

/** An image as a draft and a message name it. */
const img = (n: number, name = `i${n}.png`): ChatImage => ({ id: String(n).padStart(64, "0"), name, type: "image/png", size: 1000 + n });

const calls: { path: string; method?: string; body: unknown }[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true } };
globalThis.fetch = (async (path: string, init: RequestInit = {}) => {
  calls.push({ path, method: init.method, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body ?? undefined }); // (an upload's body is the file)
  return new Response(JSON.stringify(answer.body), { status: answer.status });
}) as typeof fetch;
beforeEach(() => { calls.length = 0; answer = { status: 200, body: { ok: true } }; });

/** A composer's saver over a server the test plays: the saves it got (puts: their texts; drafts: each whole), the unsaved copy, what was put into
 *  the box (shown: the texts; put: each draft whole). The server takes a draft of quotes or of images alone as a draft. */
function saver(rev: number, stored?: Draft) {
  const x = { rev, stored, away: false, puts: [] as { text: string; base?: number }[], drafts: [] as Draft[], shown: [] as string[], put: [] as Draft[],
    local: null as Draft | null, base: undefined as number | undefined };
  const unsaved: Unsaved = { read: () => x.local, base: () => x.base, write: (d, b) => { x.local = d; x.base = d ? b : undefined; } };
  const s = new DraftSaver(async (d, _k, base) => {
    x.puts.push({ text: d.text, base }); x.drafts.push(d);
    if (x.away) throw Object.assign(new Error("Studio is not connected."), { status: 503, code: "server_unreachable" });
    if (base !== x.rev) throw Object.assign(new Error("stale"), { status: 409, code: "stale", rev: x.rev, draft: x.stored ?? null });
    x.stored = d.text || d.references?.length || d.images?.length ? d : undefined;
    return ++x.rev;
  }, stored, unsaved, 5, rev, (d) => { x.shown.push(d.text); x.put.push(d); });
  return { x, s };
}

/** Composer.tsx's submit around its saver, for a Send that fails with e: what the box holds at the end. */
function failedSend(s: DraftSaver, text: string, e: ApiError, during: () => void = () => {}): { box: string; shown: string; refused: boolean } {
  const answered = s.sending(20);
  s.change(""); // the box is emptied at Enter
  during();
  const refused = sentNothing(e.status, e.code);
  const shown = refusalShown(e.status, e.code, true) ? e.message : "";
  const removed = answered(refused);
  let box = "";
  if (putsBack(removed)) { box = text; s.change(text); }
  return { box, shown, refused };
}

/** The same with the message's images, as Composer.tsx's submit takes them: the composer is emptied at Enter, and when the Send failed the images
 *  go back with the text, before the ones added meanwhile, but for those the refusal says the chat no longer holds (409 `image_missing`). held:
 *  what the composer holds at the end; gone: what its error line says of the images that are no longer there. */
function failedSendWith(s: DraftSaver, sent: { text: string; images: ChatImage[] }, e: ApiError, during: (held: { text: string; images: ChatImage[] }) => void = () => {}) {
  const held = { text: "", images: [] as ChatImage[] };
  const answered = s.sending(20);
  s.change("", [], [], []);
  during(held);
  const refused = sentNothing(e.status, e.code);
  const lost = e.images?.length ? sent.images.filter((x) => e.images!.includes(x.id)) : [];
  const back = withoutImages(sent.images, lost.map((x) => x.id));
  const removed = answered(refused);
  if (putsBack(removed)) {
    held.images = withImages(back, held.images);
    if (!held.text.trim()) held.text = sent.text;
    s.change(held.text, [], [], held.images);
  }
  return { held, gone: putsBack(removed) ? goneLine(lost.map((x) => x.name)) : "", refused };
}

// ---- a section's chat before its first message

test("a section's chat before its first message has the composer of any chat: its server named and fixed, its agent, folder, model, effort and subagents open", () => {
  assert.equal(showsServer(THERE), true); // the name of its server
  assert.equal(showsServer(HERE), false);
  assert.equal(serverFixed(NEW), SERVER_FINAL); // which is no choice
  assert.equal(agentOpen(NEW), true); // the agent can be changed until it starts
  assert.deepEqual(agentChoiceOn(THERE, ["claude", "pi"], NEW.agent).options, ["claude", "pi"]);
  assert.equal(pickerMode(NEW, false), pickerMode(chat(), false)); // model and effort: a choice that is saved, as on a new local chat
  assert.notEqual(pickerMode(NEW, false), "fixed");
  assert.deepEqual(subChip(NEW, false), { kind: "open" });
  assert.equal(sendOff(THERE), false);
  assert.equal(sendTitleOn(THERE, ["claude"], NEW, false), "Send (Enter)");
  assert.equal(emptyReason(THERE, ["claude"], NEW), "");
  // started, it is fixed like a started local chat
  assert.equal(agentOpen(STARTED), false);
  assert.equal(pickerMode(STARTED, false), "fixed");
  assert.equal(subChip(STARTED, false).kind, "fixed");
  // the folder is open until the first message, and is that server's; nothing is open while the chat takes no change
  assert.ok(composer.includes("const folderOpen = !frozen && (!c.locked || !!c.folderMissing);"));
  assert.ok(composer.includes("<DirPicker cwd={c.cwd} missing={c.folderMissing} locked={!folderOpen} server={where.server} onPick={(d) => api.configure(c.id, shownBranch(getState(), c.id), { cwd: d })}"));
});

test("a change of an unstarted section chat's settings is the call of a local chat under its entry, and the page takes the chat that server answers with, under its key", async () => {
  const there = chat({ agent: "pi", model: "pi-default" }); // as that server answers: its own id
  answer = { status: 200, body: { ok: true, chat: there } };
  const taken: ChatView[] = [];
  await pickAgent((p) => api.configure(K, "main", p), "pi", (c) => taken.push(c));
  await api.configure(K, "main", { model: "m2" });
  await api.configure(K, "main", { effort: "high" });
  await api.configure(K, "main", { cwd: "/home/u/work" });
  await api.configure("c_1", "main", { model: "m2" }); // this computer's chat of the same id
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
    ["PATCH", `${ON}?branch=main`, { agent: "pi" }],
    ["PATCH", `${ON}?branch=main`, { model: "m2" }],
    ["PATCH", `${ON}?branch=main`, { effort: "high" }],
    ["PATCH", `${ON}?branch=main`, { cwd: "/home/u/work" }],
    ["PATCH", "/api/chats/c_1?branch=main", { model: "m2" }],
  ]);
  assert.deepEqual(taken, [{ ...there, id: K }]); // the model and effort that server chose for the agent
});

test("the first message of a section's chat is an ordinary Send: the same call as any message, on its branch", async () => {
  await api.send(K, "main", "hello", "", []);
  await api.send("c_1", "main", "hello", "", []);
  assert.deepEqual(calls, [
    { path: `${ON}/messages?branch=main`, method: "POST", body: { text: "hello", context: "" } },
    { path: "/api/chats/c_1/messages?branch=main", method: "POST", body: { text: "hello", context: "" } },
  ]);
  // the composer sends every message so, whatever the chat's server and whether it has started: no call of its own for a first message
  assert.ok(composer.includes("return sendAt(chat, (branch, target) => api.send(chat, branch, text, context, references, target, images),\n    { text, references, ...(images.length ? { images } : {}) });"));
  assert.equal(composer.split("api.send(").length, 2);
  assert.ok(!/c\?\.server && !c\.locked/.test(composer));
  // and its saver is told of it as of any Send: nothing is held
  assert.ok(composer.includes("answered = getState().moves[chatId] ? null : drafts.current!.sending();"));
});

test("a first message with no answer: it is not known whether it arrived, and the page keeps the text", async () => {
  const lost = new ApiError(504, "Studio did not answer: it is not known whether the message arrived.", true, "send_unknown");
  // the text was the draft there (saved before Enter)
  const a = saver(3, { text: "hello" });
  const r = failedSend(a.s, "hello", lost);
  assert.deepEqual(r, { box: "hello", shown: lost.message, refused: false });
  await tick(40);
  assert.deepEqual([a.x.stored, a.x.shown], [{ text: "hello" }, []], "the text is in the box and is the draft still");
  // one sent before its text was ever saved stays in the composer too, and is saved as the draft
  const b = saver(3);
  b.s.change("typed and sent at once");
  const r2 = failedSend(b.s, "typed and sent at once", lost);
  assert.equal(r2.box, "typed and sent at once");
  await tick(40);
  assert.deepEqual(b.x.stored, { text: "typed and sent at once" });
  // no state of the chat tells of it, and nothing promises that a second Send is sent only once
  assert.equal(refreshAfterRefusal(504, "send_unknown"), false);
  for (const f of ["Composer.tsx", "ChatChoices.tsx", "ChatView.tsx", "logic/chatserver.ts", "logic/sendend.ts", "logic/drafts.ts", "store.ts", "types.ts"]) {
    const text = f === "types.ts" ? src(f).slice(src(f).indexOf("export type ChatView"), src(f).indexOf("export type BranchState")) : src(f);
    for (const gone of ["sent only once", "unconfirmed", "first_text_kept", "unmoved", "moveError"]) assert.ok(!text.includes(gone), `${f} has ${gone}`);
  }
});

test("a first message with no answer whose draft that server removed meanwhile: the message arrived, and the page does not put it back", async () => {
  const lost = new ApiError(504, "Studio did not answer: it is not known whether the message arrived.", true, "send_unknown");
  const a = saver(3, { text: "hello" });
  // that server took the message: it removed the sent draft and raised its counter, and its event came before the answer did
  const r = failedSend(a.s, "hello", lost, () => { a.x.stored = undefined; a.x.rev = 4; a.s.arrived(4, null); });
  assert.deepEqual(r, { box: "", shown: lost.message, refused: false });
  await tick(40);
  assert.deepEqual([a.x.puts, a.x.stored, a.x.shown, a.x.local], [[], undefined, [], null], "nothing is saved again, and no draft comes back");
  // text typed while it was sent is kept and saved on that server's counter
  const b = saver(3, { text: "hello" });
  const r2 = failedSend(b.s, "hello", lost, () => { b.x.stored = undefined; b.x.rev = 4; b.s.arrived(4, null); b.s.change("next thought"); });
  assert.equal(r2.box, "");
  await tick(40);
  assert.deepEqual([b.x.stored, b.x.puts.at(-1)], [{ text: "next thought" }, { text: "next thought", base: 4 }]);
});

// ---- a server that is not connected

test("a server that is not connected: the Send is off for every chat of it, started or not, and the box is read-only (it keeps what it holds and takes no more)", () => {
  for (const c of [NEW, STARTED]) {
    assert.equal(sendOff(DOWN), true);
    assert.equal(sendTitleOn(DOWN, [], c, false), notConnectedLine("Studio"));
    assert.equal(offPlaceholder(DOWN, [], c), "Studio is not connected");
    assert.deepEqual(toolbarLine(DOWN, [], c), { text: notConnectedLine("Studio"), tone: "missing" });
    assert.equal(emptyReason(DOWN, [], c), notConnectedLine("Studio"));
    assert.equal(agentChoiceOn(DOWN, ["claude"], c.agent).reason, notConnectedLine("Studio"));
  }
  assert.equal(sendOff(THERE), false);
  assert.equal(sendOff(HERE), false);
  // a chat its server no longer has says that, whatever the server's state
  for (const w of [THERE, DOWN]) {
    assert.equal(sendTitleOn(w, ["claude"], STARTED, false, true), "This chat is no longer on Studio.");
    assert.equal(offPlaceholder(w, ["claude"], STARTED, true), "This chat is no longer on Studio.");
    assert.deepEqual(toolbarLine(w, ["claude"], STARTED, true), { text: "This chat is no longer on Studio.", tone: "missing" });
  }
  // The box: read-only while the chat's server is not connected, and once that server no longer has the chat (goal 3.8:
  // the chat is read-only; what was typed and not yet taken stays in the composer and is saved when the server is back).
  assert.equal(boxOff(DOWN), true);
  assert.equal(boxOff(DOWN, true), true);
  assert.equal(boxOff(THERE, true), true, "a chat its server no longer has takes no text either");
  assert.equal(boxOff(THERE), false);
  assert.equal(boxOff(HERE), false, "a chat of this computer always takes text");
  // Send's button and Enter read the server's state, and the box is locked by it
  assert.ok(composer.includes("const off = sendOff(where);"));
  assert.ok(composer.includes("const left = useStore((s) => !!s.gone[chatId]);"));
  assert.ok(composer.includes("if ((!t && !quotes.length && !images.length) || blocked || off || left || sending || isSending(chatId)) return;"));
  assert.ok(composer.includes("disabled={blocked || off || left || sending || (!text.trim() && !quotes.length && !images.length)}"));
  const input = composer.slice(composer.indexOf("<RefInput\n"), composer.indexOf('<div className="composer-tools fitted"'));
  assert.ok(composer.includes("const readOnly = boxOff(where, left);"));
  assert.ok(input.length > 0 && input.includes("locked={readOnly}") && input.includes("readOnly={readOnly}"), "the box takes no reference, no insert and no chip removal, and is not editable");
  // nothing is typed, pasted, dropped or deleted while it is read-only: the browser's own input is stopped at the box
  const stop = composer.slice(composer.indexOf("// While the box is read-only"), composer.indexOf("// The draft: put into the box when it appears"));
  assert.ok(stop.includes('if (!readOnly || !el) return;') && stop.includes('el.addEventListener("beforeinput", stop, true);') && stop.includes("e.preventDefault()"));
  assert.ok(composer.includes("onRemove={readOnly ? undefined : (id) => setImages((now) => withoutImages(now, [id]))}"), "no image leaves a draft that cannot be saved");
  assert.ok(composer.includes("const canRef = !!board && !archived && !legacy && !readOnly && onScreen === board;"));
  // RefInput: locked, nothing is put in and nothing is taken out by its own code
  const refInput = readFileSync(new URL("../src/RefInput.tsx", import.meta.url), "utf8");
  for (const line of ["if (!el || locked) return;", "if (!el || locked || !sel?.rangeCount) return;", 'if (!locked && (e.key === "Backspace" || e.key === "Delete")', "if (copyValue(e) && !locked)", 'contentEditable={readOnly ? "false" : "plaintext-only"}', "aria-readonly={readOnly || undefined}"])
    assert.ok(refInput.includes(line), line);
  // a Send that was on its way when the connection ended is refused: nothing was sent, the text goes back, and the sentence is shown while the
  // server is still away
  const away = new ApiError(503, "Studio is not connected.", true, "server_unreachable");
  const a = saver(3, { text: "hello" });
  assert.deepEqual(failedSend(a.s, "hello", away), { box: "hello", shown: "", refused: true });
  assert.equal(refusalShown(503, "server_unreachable", false), true);
  assert.equal(refusalShown(503, "server_unreachable", true), false, "connected again by the time the refusal is handled: its sentence would say what is no longer so");
});

test("a save that fails as the server drops: the page keeps the text that was typed and not yet taken, which the open composer saves when the server is back", async () => {
  const { x, s } = saver(3, { text: "before" });
  x.away = true;
  s.change("typed while Studio was away"); s.flush();
  await tick();
  assert.deepEqual([x.puts, x.stored, x.shown], [[{ text: "typed while Studio was away", base: 3 }], { text: "before" }, []]);
  assert.deepEqual([x.local, x.base], [{ text: "typed while Studio was away" }, 3], "the unsaved copy, on the counter it was typed on");
  await tick(40);
  assert.equal(x.puts.length, 1, "it is not sent again by itself while the server is away");
  x.away = false;
  s.back();
  await tick();
  assert.deepEqual([x.stored, x.rev, x.local, x.shown], [{ text: "typed while Studio was away" }, 4, null, []]);
});

// ---- the images of a section's chat

test("the images of a section's chat go by the calls of a local chat: the upload, the fetch, the draft save and the Send, each to the chat's own address under its entry", async () => {
  const A = img(1, "shot.png");
  // the upload: the file's bytes to the chat, answered with the image as that server holds it
  answer = { status: 200, body: A };
  const file = new Blob(["png bytes"], { type: "image/png" });
  assert.deepEqual(await api.uploadImage(K, file, "shot.png", "image/png"), A);
  // the fetch: the chat's own address, which the local server fetches from that server and serves under its own headers
  assert.equal(imageUrl(K, A.id), `${ON}/images/${A.id}`);
  assert.equal(imageUrl("c_1", A.id), `/api/chats/c_1/images/${A.id}`);
  // the draft save: the images in the draft, that server's counter, and what it left out in the answer
  answer = { status: 200, body: { ok: true, rev: 4, missing: [img(2).id] } };
  assert.deepEqual(await api.saveDraft(K, "main", { text: "", images: [A, img(2)] }, 3), { rev: 4, missing: [img(2).id] });
  // the Send: the images in the message, on its branch from the first message on
  answer = { status: 200, body: { ok: true } };
  await api.send(K, "main", "see", "", [], undefined, [A]);
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
    ["POST", `${ON}/images?name=shot.png`, file],
    ["PUT", `${ON}/draft?branch=main&rev=3`, { text: "", images: [A, img(2)] }],
    ["POST", `${ON}/messages?branch=main`, { text: "see", context: "", images: [A] }],
  ]);
  // no second path: one place uploads, one sends, and nothing that handles a draft's images asks which server the chat is on
  assert.equal(src("uploads.ts").split("api.uploadImage(").length, 2);
  assert.equal(composer.split("addImages(").length, 2);
  assert.equal(composer.split("imagesOff(").length, 2, "the one place that reads the chat's server for its images says why none can be added");
  for (const f of ["uploads.ts", "chatdraft.ts", "ComposerImages.tsx", "ImageThumb.tsx", "MessageImages.tsx", "logic/messageimages.ts", "logic/drafts.ts"]) {
    assert.ok(!/serverOf|inSection|LOCAL_SERVER|[a-z]\.server\b|\/api\/on/.test(src(f)), `${f} asks for the chat's server`);
  }
  // the strip and a sent message fetch an image from the same address, whichever server the chat is on
  assert.ok(src("ComposerImages.tsx").includes("src={previewOf(chat, x.id) ?? imageUrl(chat, x.id)}"));
  assert.ok(src("logic/messageimages.ts").includes("src: imageUrl(chat, im.id)"));
});

test("a server that is not connected, or that no longer has the chat: paste of an image and the attach button are off, with the reason; the images a draft has stay, and nothing is uploaded", () => {
  const off = imagesOff({ server: DOWN.name, connected: DOWN.connected, model: "" });
  assert.deepEqual(off, { line: "Studio is not connected", title: "Studio is not connected: images can be added when it is back" });
  assert.equal(imagesOff({ server: THERE.name, connected: true, model: "" }), null, "connected again: images are taken");
  assert.equal(imagesOff({ server: HERE.name, connected: HERE.connected, model: "" }), null);
  // a chat that is gone from its server takes none either: the composer says that in the place of the server's state
  assert.ok(composer.includes("const noAdd = left ? { line: goneText(where.name), title: goneText(where.name) } : imagesOff({ server: where.name, connected: where.connected, model: noImages });"));
  // the composer asks before it uploads: the button is disabled with the tooltip, and a file that came by a paste goes to the check with the reason,
  // which refuses it there (uploads.ts addImages: no upload is started, and the error line names the file)
  assert.ok(composer.includes("<AttachButton off={noAdd?.title ?? \"\"} onClick={attach} />"));
  assert.ok(composer.includes("addImages(chatId, branch, files, { has: held().images, off: noAdd?.line, skipped });"));
  const uploads = src("uploads.ts");
  assert.ok(uploads.includes("const { take, refused } = checkFiles(asked, room, !!o.off);") && uploads.includes("setImageError(chat, branch, refusedLine([...(o.skipped ?? []), ...refused], o.off || undefined));"));
  // asked all the same (a composer that opened before the view said so), the upload is refused with that server's sentence, which the error line
  // says with the file's name
  assert.equal(uploadFailed("shot.png", "Studio is not connected."), "shot.png was not added: Studio is not connected.");
  assert.ok(uploads.includes('say(chat, branch, uploadFailed(name, e instanceof ApiError ? e.message : "the upload did not reach the server"));'));
  // the strip is drawn from what the composer holds, whatever the server's state; while the composer is read-only (the server is not
  // connected, or no longer has the chat) no image leaves the draft. An image that cannot be fetched is the plain tile (ImageThumb),
  // and is fetched again when the server is back
  const strip = src("ComposerImages.tsx"), thumb = src("ImageThumb.tsx");
  assert.ok(composer.includes("<ImageStrip chat={chatId} branch={branch} images={images} uploads={up.uploads} note={up.uploads.length ? \"\" : imagesHeld} again={where.connected}\n          onRemove={readOnly ? undefined : (id) => setImages((now) => withoutImages(now, [id]))} />"));
  assert.ok(strip.includes("again={again} onRemove={onRemove ? () => onRemove(x.id) : undefined} />"), "with no remove given, a thumbnail has no remove control");
  assert.ok(thumb.includes("const broken = !src || failed === src;") && thumb.includes("onError={() => setFailed(src)}") && thumb.includes("useEffect(() => { setFailed(null); }, [again]);"));
  assert.ok(thumb.includes('? <span className="img-thumb-name" role="img" aria-label={name} data-text={name} />'));
  assert.ok(src("ChatView.tsx").includes("<MessageImages chat={chat.id} images={images} alone={!words} again={connected} />"), "a sent message's images too");
  // Send: the images hold it for nothing the server's state says; it is off as with text alone
  assert.equal(imagesHold([img(1)], false, ""), "");
  assert.ok(composer.includes("const imagesHeld = imagesHold(images, up.uploads.length > 0, noImages);"));
  assert.equal(sendOff(DOWN), true);
});

test("an image is removed from the draft as its server drops: the save fails, the page keeps what is left, and it is saved when the server is back", async () => {
  const A = img(1), B = img(2);
  const { x, s } = saver(3, { text: "see", images: [A, B] });
  x.away = true;
  s.change("see", [], [], [A]); s.flush(); // B's remove control
  await tick();
  assert.deepEqual([x.drafts, x.stored, x.put], [[{ text: "see", images: [A] }], { text: "see", images: [A, B] }, []]);
  assert.deepEqual([x.local, x.base], [{ text: "see", images: [A] }, 3], "the unsaved copy names the image that is left, on the counter it was typed on");
  // the text is deleted too: a draft of an image alone is a draft, kept and saved as one
  s.change("", [], [], [A]); s.flush();
  await tick();
  assert.deepEqual([x.local, x.stored], [{ text: "", images: [A] }, { text: "see", images: [A, B] }]);
  x.away = false;
  s.back();
  await tick();
  assert.deepEqual([x.stored, x.rev, x.local, x.put], [{ text: "", images: [A] }, 4, null, []]);
  // the last image is removed while the server is away: the emptied draft is what is saved when it is back
  x.away = true;
  s.change("", [], [], []); s.flush();
  await tick();
  assert.deepEqual([x.local, x.stored], [{ text: "" }, { text: "", images: [A] }]);
  x.away = false;
  s.back();
  await tick();
  assert.deepEqual([x.stored, x.rev, x.local], [undefined, 5, null]);
});

test("a Send that fails, or whose arrival is not known, keeps the images with the text: in the composer and as the draft", async () => {
  const A = img(1, "a.png"), B = img(2, "b.png"), C = img(3, "c.png");
  const lost = new ApiError(504, "Studio did not answer: it is not known whether the message arrived.", true, "send_unknown");
  const away = new ApiError(503, "Studio is not connected.", true, "server_unreachable");
  const gone = new ApiError(404, "no such chat", true, "not_found");
  for (const e of [lost, away, gone]) {
    // the message was the draft there (saved before Enter): text and images go back, and are the draft still
    const a = saver(3, { text: "see", images: [A, B] });
    const r = failedSendWith(a.s, { text: "see", images: [A, B] }, e);
    assert.deepEqual([r.held, r.gone], [{ text: "see", images: [A, B] }, ""], e.code);
    await tick(40);
    assert.deepEqual([a.x.stored, a.x.put, a.x.local], [{ text: "see", images: [A, B] }, [], null], e.code);
    // a message of images alone is no empty one: it goes back, and is saved as the draft
    const b = saver(3);
    b.s.change("", [], [], [A]);
    const r2 = failedSendWith(b.s, { text: "", images: [A] }, e);
    assert.deepEqual(r2.held, { text: "", images: [A] }, e.code);
    await tick(40);
    assert.deepEqual(b.x.stored, { text: "", images: [A] }, e.code);
    // an image added and a text typed while it was sent stay: the sent images stand before the new one, each once
    const c = saver(3, { text: "see", images: [A, B] });
    const r3 = failedSendWith(c.s, { text: "see", images: [A, B] }, e, (held) => { held.text = "next"; held.images = [C, A]; c.s.change("next", [], [], [C, A]); });
    assert.deepEqual(r3.held, { text: "next", images: [A, B, C] }, e.code);
    await tick(40);
    assert.deepEqual(c.x.stored, { text: "next", images: [A, B, C] }, e.code);
  }
  // what the composer does with them
  assert.ok(composer.includes("const p = picked, qs = quotes, im = images;"));
  assert.ok(composer.includes("const back = withoutImages(im, lost.map((x) => x.id));"));
  assert.ok(composer.includes("setImages((now) => withImages(back, now)); // and the images, before the ones added meanwhile"));
  assert.ok(composer.includes("if (gone.current && !sendFailed(chatId, branch, { text: t, mentions: p, references: qs, images: back }, e)) drafts.current!.change(t, p, qs, back);"));
});

test("a Send with no answer whose draft that server removed meanwhile: the message arrived, and neither its text nor its images are put back", async () => {
  const A = img(1), B = img(2);
  const lost = new ApiError(504, "Studio did not answer: it is not known whether the message arrived.", true, "send_unknown");
  const a = saver(3, { text: "", images: [A] }); // a message of an image alone
  const r = failedSendWith(a.s, { text: "", images: [A] }, lost, () => { a.x.stored = undefined; a.x.rev = 4; a.s.arrived(4, null); });
  assert.deepEqual(r.held, { text: "", images: [] });
  await tick(40);
  assert.deepEqual([a.x.drafts, a.x.stored, a.x.put, a.x.local], [[], undefined, [], null], "nothing is saved again, and no draft comes back");
  // an image added while it was sent is kept and saved on that server's counter
  const b = saver(3, { text: "see", images: [A] });
  const r2 = failedSendWith(b.s, { text: "see", images: [A] }, lost, (held) => { b.x.stored = undefined; b.x.rev = 4; b.s.arrived(4, null); held.images = [B]; b.s.change("", [], [], [B]); });
  assert.deepEqual(r2.held, { text: "", images: [B] });
  await tick(40);
  assert.deepEqual([b.x.stored, b.x.puts.at(-1)], [{ text: "", images: [B] }, { text: "", base: 4 }]);
});

test("a Send refused because the chat's server no longer holds an image: that image stays out, the others go back, and the line says what to add again", async () => {
  const A = img(1, "kept.png"), B = img(2, "lost.png");
  const e = new ApiError(409, "The chat does not hold an image of the message.", true, "image_missing");
  e.images = [B.id];
  const a = saver(3, { text: "see", images: [A, B] });
  const r = failedSendWith(a.s, { text: "see", images: [A, B] }, e);
  assert.deepEqual(r, { held: { text: "see", images: [A] }, gone: "No longer there, add again: lost.png.", refused: true });
  await tick(40);
  assert.deepEqual(a.x.stored, { text: "see", images: [A] });
  assert.equal(refreshAfterRefusal(409, "image_missing"), false, "the chat is not read again: the message stays in the box");
  assert.ok(composer.includes("if (!gone.current) imagesGone(chatId, branch, lost);"));
});

test("two clients in one draft, the user's page and that server's own page or another client's: images go both ways, and a draft of images alone is nobody's empty one", async () => {
  const A = img(1), B = img(2);
  // the other page saved a draft with images: nothing typed here, so it is put into this composer, images and all
  const a = saver(3, { text: "mine" });
  a.x.stored = { text: "theirs", images: [A] }; a.x.rev = 4;
  a.s.arrived(4, { text: "theirs", images: [A] });
  assert.deepEqual(a.x.put, [{ text: "theirs", images: [A] }]);
  // the other page added an image to the same text: another draft, shown
  a.x.rev = 5;
  a.s.arrived(5, { text: "theirs", images: [A, B] });
  assert.deepEqual(a.x.put.at(-1), { text: "theirs", images: [A, B] });
  // an image added here while the other page saved: this page's save is refused as stale, and a draft of an image alone stays and is saved again on
  // that server's counter, as text is (an emptied draft would show the server's instead)
  const b = saver(3);
  b.x.stored = { text: "typed there" }; b.x.rev = 4;
  b.s.change("", [], [], [A]); b.s.flush();
  await tick(40);
  assert.deepEqual([b.x.puts.map((p) => p.base), b.x.stored, b.x.put, b.x.local], [[3, 4], { text: "", images: [A] }, [], null]);
  // the other page sent or cleared the draft: a saved draft of an image alone goes from this composer, as saved text does
  const c = saver(3, { text: "", images: [A] });
  c.x.stored = undefined; c.x.rev = 4;
  c.s.arrived(4, null);
  assert.deepEqual(c.x.put, [{ text: "" }]);
  // "empty" everywhere a draft is asked for: an image alone is a draft of the chat, of the branch shown and of another branch
  const alone: Draft = { text: "", images: [A] };
  assert.equal(hasDraft(alone), true);
  assert.equal(chatHasDraft(chat({ id: K, draft: alone })), true);
  assert.equal(otherDrafts([{ branch: "main" }, { branch: "ab12cd34", draft: alone }], "main"), true);
  assert.equal(hasDraft({ text: "", images: [] }), false);
});

// ---- the answers of the Go servers to a Send with images, as they are on the wire (plans/remote-server-sections-contract.md 3.5): what the
// local server answers by the entry's state, and that server's own answers, handed on as they came

test("every answer of the servers to a Send with images that was not taken: the text and the images go back, but for those the answer says the chat no longer holds, and the page knows whether anything was sent and whether to read the chat again", async () => {
  const A = img(1, "a.png"), B = img(2, "b.png");
  type Row = { status: number; body: { error: string; code?: string; images?: string[] }; refused: boolean; refresh: boolean; lost?: ChatImage[] };
  const rows: Row[] = [
    // checked on the local server before anything is passed on
    { status: 400, body: { error: "an image id is 64 lower-case hex digits", code: "image_id" }, refused: true, refresh: false },
    // the chat's server's own refusals, handed on with their body: `images` names what the chat does not hold
    { status: 409, body: { error: "the chat no longer holds one of the message's images: add it again", code: "image_missing", images: [B.id] }, refused: true, refresh: false, lost: [B] },
    { status: 400, body: { error: "a message takes at most 10 images, and this one has 11", code: "image_limit" }, refused: true, refresh: false },
    { status: 400, body: { error: "the model takes no images", code: "image_model" }, refused: true, refresh: false },
    { status: 409, body: { error: "the chat is busy", code: "busy" }, refused: true, refresh: true },
    { status: 409, body: { error: "the chat is archived" }, refused: true, refresh: true },
    { status: 409, body: { error: "this chat has no agent: choose one first", code: "no_agent" }, refused: true, refresh: false },
    { status: 404, body: { error: "no such chat", code: "not_found" }, refused: true, refresh: false }, // the chat is gone there
    // the way there, by the entry's state: nothing is sent for an entry that is gone from the list, not connected or too old
    { status: 404, body: { error: "This server is not in the list.", code: "no_server" }, refused: true, refresh: false },
    { status: 503, body: { error: "Studio is not connected.", code: "server_unreachable" }, refused: true, refresh: false },
    { status: 503, body: { error: "Studio is too old: update the server on that machine.", code: "server_unreachable" }, refused: true, refresh: false },
    { status: 504, body: { error: "Studio did not answer: it is not known whether the message arrived.", code: "send_unknown" }, refused: false, refresh: false },
    { status: 502, body: { error: "Studio gave an answer that cannot be read.", code: "bad_answer" }, refused: false, refresh: false },
  ];
  for (const row of rows) {
    const what = `${row.status} ${row.body.code ?? ""}`;
    answer = { status: row.status, body: row.body };
    const e = await api.send(K, "main", "see", "", [], undefined, [A, B]).then(() => null, (x) => x as ApiError);
    assert.ok(e instanceof ApiError, what);
    assert.deepEqual([e.status, e.code, e.message, e.images], [row.status, row.body.code, row.body.error, row.body.images], what);
    const a = saver(3, { text: "see", images: [A, B] });
    const back = [A, B].filter((x) => !row.lost?.includes(x));
    const r = failedSendWith(a.s, { text: "see", images: [A, B] }, e);
    assert.deepEqual(r, { held: { text: "see", images: back }, gone: row.lost ? `No longer there, add again: ${row.lost.map((x) => x.name).join(", ")}.` : "", refused: row.refused }, what);
    await tick(40);
    assert.deepEqual([a.x.stored, a.x.put], [{ text: "see", images: back }, []], `${what}: what went back is the draft`);
    assert.equal(refreshAfterRefusal(e.status, e.code), row.refresh, `${what}: the chat is read again`);
    // the sentence is shown under the composer, but the one of a server that has connected again by the time it is handled
    assert.equal(refusalShown(e.status, e.code, false), true, what);
    assert.equal(refusalShown(e.status, e.code, true), e.code !== "server_unreachable", what);
  }
  assert.ok(calls.every((c) => c.method === "POST" && c.path === `${ON}/messages?branch=main`));
  // what tells the composer that nothing was sent: any refusal below 500, and the 503 of a server that is not connected
  assert.ok(composer.includes("refused = e instanceof ApiError && sentNothing(e.status, e.code);"));
  assert.deepEqual([sentNothing(503, "server_unreachable"), sentNothing(503), sentNothing(504, "send_unknown"), sentNothing(502), sentNothing(undefined), sentNothing(409, "busy")],
    [true, false, false, false, false, true]);
});

test("the line under the composer is a refusal's own sentence, else the chat's error", () => {
  assert.equal(underComposer("", chat({ id: K, status: "error", error: "the agent stopped" })), "the agent stopped");
  assert.equal(underComposer("", chat({ id: K, error: "old" })), "");
  assert.equal(underComposer("", chat({ id: K })), "");
  assert.equal(underComposer("Studio is not connected.", chat({ id: K, status: "error", error: "the agent stopped" })), "Studio is not connected.");
  // (the refusal's sentence comes with what the uploads say of the images)
  assert.ok(composer.includes('const under = underComposer([err, up.error].filter(Boolean).join(" "), c);') && composer.includes('{under && <div className="composer-err">{under}</div>}'));
});

test("a Send answered that nothing was sent (its server is not connected, the chat is gone there): the page keeps what the user typed, and the Send is over for the saver at once", async () => {
  const away = new ApiError(503, "Studio is not connected.", true, "server_unreachable");
  const gone = new ApiError(404, "no such chat", true, "not_found");
  for (const e of [away, gone]) {
    assert.equal(sentNothing(e.status, e.code), true, `${e.status} ${e.code}`);
    assert.equal(refusalShown(e.status, e.code, false), true);
    assert.equal(refreshAfterRefusal(e.status, e.code), false, "the chat is not read again: nothing here is stale");
    // the text was the draft there (the sentence of a server that is connected again by now is not shown: failedSend handles it so)
    const a = saver(3, { text: "hello" });
    assert.deepEqual(failedSend(a.s, "hello", e), { box: "hello", shown: e === away ? "" : e.message, refused: true });
    await tick(40);
    assert.deepEqual([a.x.stored, a.x.shown, a.x.local], [{ text: "hello" }, [], null]);
    // typed and sent at once: back in the box, and saved
    const b = saver(3);
    b.s.change("just typed");
    assert.equal(failedSend(b.s, "just typed", e).box, "just typed");
    await tick(40);
    assert.deepEqual(b.x.stored, { text: "just typed" });
    // the Send is over for the saver at once: a removal of the draft that comes right after it is another client's, and empties the box
    const c = saver(3, { text: "hello" });
    failedSend(c.s, "hello", e);
    c.x.stored = undefined; c.x.rev = 4; c.s.arrived(4, null);
    assert.deepEqual(c.x.shown, [""]);
  }
});

test("a page open while that server tells of the draft again loses nothing: the box keeps what was typed, on the same counter or a higher one", async () => {
  // text typed and not saved yet as the events of a section's tree come: the draft it had, on the same counter
  const a = saver(4, { text: "kept here" });
  a.s.change("kept here, and more");
  a.s.arrived(4, { text: "kept here" });
  await tick(40);
  assert.deepEqual([a.x.shown, a.x.puts, a.x.stored], [[], [{ text: "kept here, and more", base: 4 }], { text: "kept here, and more" }]);
  // on a higher counter: what was typed stays, and its save names that server's counter
  const b = saver(4, { text: "kept here" });
  b.s.change("kept here, and more");
  b.x.rev = 9;
  b.s.arrived(9, { text: "kept here" });
  await tick(40);
  assert.deepEqual([b.x.shown, b.x.puts, b.x.stored, b.x.local], [[], [{ text: "kept here, and more", base: 9 }], { text: "kept here, and more" }, null]);
  // nothing typed since: the draft it had arrives again, on either counter, and nothing is put into the box or saved
  for (const rev of [4, 9]) {
    const c = saver(4, { text: "kept here" });
    c.x.rev = rev;
    c.s.arrived(rev, { text: "kept here" });
    await tick(40);
    assert.deepEqual([c.x.shown, c.x.puts], [[], []], String(rev));
    // and the next thing typed is saved on the counter that server has
    c.s.change("kept here!"); c.s.flush();
    await tick();
    assert.deepEqual([c.x.puts, c.x.stored], [[{ text: "kept here!", base: rev }], { text: "kept here!" }], String(rev));
  }
  // a save that was on its way as another client saved: refused as stale by the counter that server has, the text stays and is saved there
  const d = saver(4, { text: "kept here" });
  d.x.rev = 9;
  d.s.change("typed meanwhile"); d.s.flush();
  await tick(40);
  assert.deepEqual([d.x.shown, d.x.puts.map((p) => p.base), d.x.stored], [[], [4, 9], { text: "typed meanwhile" }]);
  // a counter that went down would be ignored for good, which is why it never does: the saver takes no earlier one
  const e = saver(9, { text: "kept here" });
  e.s.arrived(4, { text: "other" });
  assert.deepEqual(e.x.shown, []);
  // an image added on that server's own page arrives with its draft and is put into the box that typed nothing since, and one added here is
  // saved on that server's counter with the text
  const f = saver(4, { text: "kept here" });
  f.x.rev = 10; f.x.stored = { text: "kept here", images: [img(1)] };
  f.s.arrived(10, { text: "kept here", images: [img(1)] });
  assert.deepEqual(f.x.put, [{ text: "kept here", images: [img(1)] }]);
  f.s.change("kept here", [], [], [img(1), img(2)]); f.s.flush();
  await tick();
  assert.deepEqual([f.x.puts.at(-1), f.x.stored], [{ text: "kept here", base: 10 }, { text: "kept here", images: [img(1), img(2)] }]);
});
