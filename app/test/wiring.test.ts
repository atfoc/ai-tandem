// The wiring of the screens that the old page's unit tests (web/test) read as source: the composer's and the chat view's use of the logic
// of core, per chat's server, in the new build's files. Each test has the name of the old one and asserts what that one asserted of
// the old page's source, in the form the new build has it (a screen is a folder of files; the markup is React Native's). What the old tests also read
// of the page's DOM (class names, `window` listeners, `contentEditable`) has no counterpart, and is not asserted here: the browser checks
// of web/dev/checks show those behaviours, and plans/rn-rewrite/parity/webtest.md says, test by test, which. The logic these screens call
// is core's and has its own tests (packages/core/test); here is only which logic a screen calls, and with what.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appSrc = path.join(here, "../src"), coreSrc = path.join(here, "../../packages/core/src");
const file = (rel: string): string => fs.readFileSync(path.join(appSrc, rel), "utf8");
/** The text of the files of a folder of the app (not of its folders), in the order of their names. */
const dir = (rel: string): string => fs.readdirSync(path.join(appSrc, rel)).filter((f) => /\.tsx?$/.test(f)).sort().map((f) => file(`${rel}/${f}`)).join("\n");
const core = (rel: string): string => fs.readFileSync(path.join(coreSrc, rel), "utf8");
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

const composer = dir("screens/composer"), composerTsx = file("screens/composer/Composer.tsx"), toolbar = file("screens/composer/Toolbar.tsx");
const choices = file("screens/composer/ChatChoices.tsx"), chatView = dir("screens/chat"), hooks = file("screens/chat/hooks.ts");
const nav = file("screens/shell/nav.ts"), sidebarActions = file("screens/sidebar/actions.ts");

// ---- the toolbar: the server's name, then the four choices

test("the toolbar has the server's name, then agent, folder, model, effort, in this order", () => {
  const at = ["server: showsServer(where)", "agent: agentPick", "folder: <>", "model: mode ===", "effort: choices"].map((mark) => {
    assert.equal(toolbar.split(mark).length, 2, `${mark} is in the toolbar once`);
    return toolbar.indexOf(mark);
  });
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
  assert.equal(count(toolbar, /<DirPicker /g), 1);
  assert.ok(toolbar.includes('title="Model"') && toolbar.includes('title="Effort"'));
  assert.equal(count(choices, /title="Agent"/g), 1);
});

test("the server picker is gone from the toolbar: the server is a chip that opens nothing and sends nothing", () => {
  // no list of servers, no pick, no call that names a server, in the toolbar or in what it draws
  for (const [name, text] of [["the composer", composer], ["ChatChoices.tsx", choices]] as const) {
    for (const gone of ["ServerPick", "serverChoice", "pickServer", "serverOptions", 'title="Server"', "server-pick", "{ server: id }", "server: id"]) assert.ok(!text.includes(gone), `${name} has ${gone}`);
  }
  assert.ok(!choices.includes("openServers"), "no Servers… item");
  const chip = choices.slice(choices.indexOf("export function ServerChip("), choices.indexOf("export function useServerChip("));
  assert.ok(chip.length > 0 && !chip.includes("<Picker") && !chip.includes("api.") && !chip.includes("onPress"), "the chip is no control");
  // (the name in an element of its own, which is cut where it is long; the chip's title is the reason, the name's has the name whole)
  assert.ok(chip.includes("title={`Server — ${fixed}`}") && chip.includes("<ChipName muted full={`${w.name} — ${fixed}`}>{w.name}</ChipName>"));
  assert.ok(chip.includes("const fixed = serverFixed(c);"));
  // a list that stays for the others: a disabled option takes no pick, by the press or by Enter
  assert.ok(composer.includes("if (!o || o.disabled) return;"));
  assert.ok(composer.includes("disabled={o.disabled}") && composer.includes("useControlRef(o.disabled ? o.note : undefined)"), "a disabled option says why");
});

test("an agent pick sends the agent alone and takes the chat the server answers with", async () => {
  // the component gives it the store's upsertChat
  assert.ok(/pickAgent\(\(p\) => api\.configure\(c\.id, shownBranch\(getState\(\), c\.id\), p\), id as AgentKind, upsertChat\)/.test(choices));
});

test("the agent choice is in the toolbar only while agentOpen and the chat takes a change; the server's name only for a chat of a section, started or not", () => {
  assert.equal(count(composer, /<AgentPick\b/g), 1);
  assert.ok(toolbar.includes("agent: agentPick ? <AgentPick "), "AgentPick is under agentPick");
  // (not while the chat's server is not connected, or no longer has the chat: it is shown as it was, and takes no change)
  assert.ok(toolbar.includes("const agentPick = agentOpen(c) && !frozen;") && toolbar.includes("const frozen = sendOff(where) || gone;"));
  assert.ok(toolbar.includes("if (agentPick) keys.agent = agentKey;"), "and it has its place in the fit only then");
  assert.equal(count(composer, /<ServerChip\b/g), 1);
  assert.ok(toolbar.includes("server: showsServer(where) ? <ServerChip c={c} /> : null,"), "ServerChip is under showsServer(where)");
  assert.ok(toolbar.includes("if (showsServer(where)) keys.server = serverKey;"), "and it has its place in the fit only then");
});

test("each choice is drawn once, in the toolbar's row or in its popup, and the reason line is the row's own", () => {
  // one node per control, placed by the fit: the row draws those that stay, the popup the rest 
  assert.ok(toolbar.includes("{f.toolbar.filter((id) => keys[id] && widths.get(keys[id]!) !== undefined).map((id) => <View key={id} style={styles.control} {...tid(\"tool\", { control: id })}>{chips[id]}</View>)}"));
  assert.ok(toolbar.includes('{f.popup.map((id) => <View key={id} {...tid("more-row", { control: id })}'));
  assert.equal(count(toolbar, /chips\[id\]/g), 4, "the row, the popup, the measuring of a width not known yet, and the test for that");
  // the line that says why a chat has no agent is not part of the agent's chip, which may be in the popup
  const pick = choices.slice(choices.indexOf("export function AgentPick("), choices.indexOf("export function useAgentChip("));
  assert.ok(pick.length > 0 && !pick.includes("agent-reason"));
  // (shown while the agent can be chosen, and whenever the chat takes no change: the line then says that its server is not connected, or no longer has it)
  assert.ok(toolbar.includes("const reason = (agentOpen(c) || frozen) && !!toolbarLine(where, usable, c, gone).text;") && toolbar.includes("{reason ? <AgentReason c={c} /> : null}"));
  assert.ok(toolbar.indexOf("<AgentReason ") > toolbar.indexOf("<ContextMeter "), "after the row's controls");
});

test("the agent choice offers the usable agents alone; one the server lacks is marked and its line says why", () => {
  // the component takes options, mark and line from these
  assert.ok(/agentChoiceOn\(w, usable, c\.agent\)/.test(choices) && /toolbarLine\(w, usable, c, gone\)/.test(choices) && /usableAgents\(s, w\.server\)/.test(choices));
  assert.ok(!choices.includes("AGENT_ORDER"), "ChatChoices.tsx lists no fixed agents");
});

test("a chat with no agent shows the reason, and its Send is blocked with the reason as its title", () => {
  // the composer reads all of it from here
  assert.ok(composerTsx.includes("sendTitleFor(sendTitleOn(where, usable, c, blocked, left), enters)} disabled={blocked || off || left || sending ||"));
  assert.ok(composerTsx.includes("const placeholder = offPlaceholder(where, usable, c, left) || (c.board"));
  assert.ok(choices.includes("if (!line.text) return null;") && choices.includes('tid("agent-reason"'), "the line is under the toolbar");
  assert.ok(/<ChipName missing>No agent<\/ChipName>/.test(choices) && /: "No agent"/.test(choices), "the chip says No agent");
  assert.ok(/\) : !c\.agent \? null : !cat \? \(/.test(toolbar), "no model choice without an agent");
  // nor for a server that is not connected: the model is then a fixed chip that says why
  assert.ok(toolbar.includes('const mode = pick || frozen ? "fixed" : pickerMode(c, !!move);'));
  assert.ok(toolbar.includes("const frozenWhy = gone ? goneText(where.name) : notConnectedLine(where.name);"));
});

test("a Send refused for the agent keeps the typed text: the chat is not read again", () => {
  // the composer puts the text back and asks this before it reads the chat again
  assert.ok(composerTsx.includes("if (!current.current.trim()) input.current?.set(t); // nothing typed is lost"));
  assert.ok(composerTsx.includes("if (e instanceof ApiError && refreshAfterRefusal(e.status, e.code)) void refreshChat(chatId, e.code);"));
});

test("a chat with no agent: its header and its empty thread name no agent, say why, and offer nothing to send", () => {
  const empty = file("screens/chat/Empty.tsx");
  // the header: a name where the agent's would be, so the line starts with no separator
  assert.ok(/\{agentLabel\(c\.agent\)\}[\s\S]{0,200}\{c\.cwd \? <> · /.test(file("screens/chat/Header.tsx")));
  // the empty thread: the title, the reason in place of what an agent's chat says, the hint, and no suggestions
  assert.ok(empty.includes('tid("empty-title")') && empty.includes("{agentLabel(agent)}</Text>"));
  assert.ok(/\{reason\s+\? <Text \{\.\.\.tid\("empty-reason"\)\}[^>]*>\{reason\}<\/Text>\s+: c\.board/.test(empty));
  assert.ok(empty.includes('const hint = off ? "" : configHint(usable, c.agent);') && empty.includes('tid("config-hint")'));
  assert.ok(empty.includes("const suggest = reason ? [] : c.board"));
  assert.ok(!chatView.includes("they lock when you send"), "the hint's text is in logic/agentlist.ts");
});

// ---- a chat's composer and what it says by the chat's server

test("the composer's Where is the chat's server, its name and whether it is connected", () => {
  assert.ok(hooks.includes('const server = of && "server" in of ? of.server : serverOf(of);') && hooks.includes("serverName(s, server)") && hooks.includes("serverConnected(s, server)"));
  // (a chat on a board of a section is in that section: its own key says so, and no board is asked)
  assert.ok(hooks.includes("export function useWhere(of?: { id?: string } | { server: string } | null): Where {"));
  assert.ok(!hooks.includes("serverOnBoard") && !composer.includes("serverOnBoard") && !chatView.includes("serverOnBoard"));
  assert.ok(composerTsx.includes("const where = useWhere(c);") && file("screens/chat/Header.tsx").includes("useWhere("));
  assert.ok(composerTsx.includes("usableAgents(s, where.server)") && choices.includes("usableAgents(s, w.server)"));
  // model and effort come from that server's catalog
  assert.equal(composer.split("catalogFor(s, serverOf(c), c.agent)").length, 3);
  assert.ok(!composer.includes("catalogFor(s, LOCAL_SERVER"));
});

test("a server that is not connected: no agent is offered, the line says why, and Send is off with that title", () => {
  // the composer: Send's button and Enter
  assert.ok(composerTsx.includes("const off = sendOff(where);"));
  assert.ok(composerTsx.includes("if ((!t && !quotes.length && !images.length) || blocked || off || left || sending || isSending(chatId)) return;"));
  assert.ok(composerTsx.includes("disabled={blocked || off || left || sending || (!text.trim() && !quotes.length && !images.length)}"));
  // no choice of a model and no "Loading models…" while it is not connected: every choice of the toolbar is a fixed chip that says why
  assert.ok(toolbar.includes("const frozen = sendOff(where) || gone;"));
  assert.ok(toolbar.includes("const frozenWhy = gone ? goneText(where.name) : notConnectedLine(where.name);"));
  assert.ok(toolbar.includes('const mode = pick || frozen ? "fixed" : pickerMode(c, !!move);'));
  assert.ok(toolbar.includes('const fixedTitle = frozen ? frozenWhy : c.fresh ? "Starting the agent on this model…" : "Model and effort are fixed once the chat has started";'));
  assert.ok(toolbar.includes("const folderOpen = !frozen && (!c.locked || !!c.folderMissing);") && toolbar.includes("const agentPick = agentOpen(c) && !frozen;"));
  // nor a Stop: the button is not drawn (the Esc key is the composer's, with the same condition)
  assert.ok(composerTsx.includes("const showStop = stop && !frozen;") || composer.includes("const showStop = stop && !frozen;"));
});

test("a chat of a section before its first message is a chat like any other: no line of its own, its agent open, its Send by the connection", () => {
  for (const [name, text] of [["ChatChoices.tsx", choices], ["the composer", composer], ["the chat view", chatView], ["logic/chatserver.ts", core("logic/chatserver.ts")],
    ["logic/sendend.ts", core("logic/sendend.ts")], ["logic/subsettings.ts", core("logic/subsettings.ts")], ["logic/serverlists.ts", core("logic/serverlists.ts")], ["state/store.ts", core("state/store.ts")]] as const) {
    for (const gone of ["unconfirmed", "sent only once", "first_text_kept", "FIRST_TEXT_KEPT", "start_unconfirmed", "startsThere", "setStarting"]) assert.ok(!text.includes(gone), `${name} has ${gone}`);
  }
  // the text stays in the box after a send with no answer (504) or to a server that is not connected (503): the failed send's path
  assert.ok(composerTsx.includes("setErr(e?.message ?? String(e));"));
  assert.ok(composerTsx.includes("if (!current.current.trim()) input.current?.set(t); // nothing typed is lost"));
});

test("a path is shortened with the home of the chat's server", () => {
  assert.ok(hooks.includes("export const tildify = (p?: string, server: string = LOCAL_SERVER): string => tildeBy(listsOf(getState(), server)?.home, p);"));
  assert.ok(file("screens/composer/Folder.tsx").includes("const tilde = (p?: string) => tildify(p, server);"));
});

test("the folder picker reads the chat's server, is titled by it and starts at its default folder", () => { // lists that never came: the server's own start
  const folder = file("screens/composer/Folder.tsx");
  assert.ok(folder.includes("api.dirs(p, server)") || folder.includes("const r = await api.dirs(p, server);"));
  assert.ok(folder.includes("folderStarts(listsOf(getState(), server))"));
  assert.ok(toolbar.includes("server={where.server} onPick={(d) => api.configure(c.id, shownBranch(getState(), c.id), { cwd: d })}"));
  assert.ok(folder.includes("server={server}"));
});

test("recent folders are kept per server: this computer's in the browser, a section's in the page's memory alone", () => {
  const recent = file("screens/composer/recent.ts"), folder = file("screens/composer/Folder.tsx");
  // the list in use: this computer's is read and written under the one key, another server's in a map of the page, and the chat's server is the one handed down
  assert.ok(recent.includes("(server === LOCAL_SERVER ? recentFrom(safeGet(RECENT_KEY)) : recentThere.get(server) ?? [])"));
  assert.ok(recent.includes("if (server === LOCAL_SERVER) safeSet(RECENT_KEY, JSON.stringify(next)); else recentThere.set(server, next);"));
  assert.equal(count(composer, /safeSet\(RECENT_KEY/g), 1, "the one write to the storage, behind the test for this computer");
  assert.ok(folder.includes("rememberDir(d, server);") && folder.includes("recentDirs(server).filter("));
  assert.ok(!composer.includes('"aiwb.dirs"'));
});

test("plan usage asks the chat's server, is kept by server and agent, and is titled by the server", () => {
  const useUsage = file("screens/usage/useUsage.ts"), popup = file("screens/usage/Popup.tsx");
  assert.ok(useUsage.includes("const key = usageKey(server, agent);"));
  assert.ok(useUsage.includes("const r = await api.usage(agent, fresh, server); lastUsage[key] = r; setU(r);"));
  assert.ok(useUsage.includes("useState<PlanUsage | null>(lastUsage[key] ?? null)"));
  assert.ok(popup.includes("<PlanSection key={usageKey(where.server, c.agent)} agent={c.agent} server={where.server} title={title} />"));
  assert.ok(popup.includes("const title = own && usageTitleOn(where, own);")); // pi has none, there as here
});

test("emptyReason: what an empty thread says of a chat that takes no message, by its server (F1, F12)", () => {
  const empty = file("screens/chat/Empty.tsx"), header = file("screens/chat/Header.tsx");
  // the empty thread uses it, offers no suggestion with it, and shows no agent and no hint for a server that is not connected
  assert.ok(empty.includes("const reason = emptyReason(where, usable, c, gone);") && empty.includes("const suggest = reason ? []"));
  assert.ok(empty.includes('const agent = off ? "" : c.agent;') && empty.includes('const hint = off ? "" : configHint(usable, c.agent);'));
  assert.ok(!chatView.includes("noAgentReason(usable)"));
  // the header says no "Ready" for it, and the toolbar offers no model and no effort
  assert.ok(header.includes("const frozen = sendOff(where) || gone;"));
  assert.ok(header.includes("const status = headStatus(c, isLegacy(c), statusText(c, boardNames(chatId), now), frozen);"));
  assert.ok(toolbar.includes(") : !c.agent ? null : !cat ? ("));
});

test("the chat header shortens the folder with the home of the chat's server (F2)", () => {
  const header = file("screens/chat/Header.tsx");
  assert.ok(header.includes("tildify(c.cwd, server)") && !header.includes("tildify(c.cwd)"));
});

test("a refusal's sentence under the composer goes when the server is connected again, and with the chat's start and choices (F3, F4)", () => {
  assert.ok(composerTsx.includes("if (refusalShown(e instanceof ApiError ? e.status : undefined, code, serverConnected(getState(), where.server))) setErr(e?.message ?? String(e));"));
  assert.ok(/useEffect\(\(\) => \{ if \(where\.connected\) setErr\(""\); \}, \[where\.connected\]\);/.test(composerTsx));
  assert.ok(/useEffect\(\(\) => \{ setErr\(""\); \}, \[c\?\.locked, c\?\.agent, c\?\.cwd, c\?\.model, c\?\.effort/.test(composerTsx));
});

test("sendingLine: the line of a fork's or a branch's first message on its way to another server", () => {
  // (the first message of a chat is an ordinary Send: the thread shows it when the server's event brings it, and nothing in its place meanwhile)
  assert.ok(!chatView.includes("sendingLine") && chatView.includes('case "empty": return <EmptyThread c={chat} gone={gone} />;'));
});

test("offWhy: why a chat takes no call, which every control of its view that is off says", () => {
  // the controls read it through one hook, by the chat's key: a message's actions, the header's way to another branch,
  // Back, the tree popup, a permission request, a subagent's thread
  assert.ok(hooks.includes("export function useOffWhy(chat: string): string {") && hooks.includes("return offWhy(w, gone);"));
  for (const f of ["screens/fork/Message.tsx", "screens/fork/Chrome.tsx", "screens/fork/TreePopup.tsx", "screens/tools/PermCard.tsx"]) assert.ok(file(f).includes("useOffWhy("), f);
  assert.ok(dir("screens/subagents").includes("useOffWhy(") || dir("screens/subagents").includes("offWhy"), "a subagent's thread");
});

test("a chat its server no longer has takes no Send and no change, and the Send, the box and the toolbar's line say so", () => {
  // the page knows it by the chat's key (store.gone), not by a field of the chat
  assert.ok(composerTsx.includes("const left = useStore((s) => !!s.gone[chatId]); // its server no longer has the chat"));
  assert.ok(composerTsx.includes("sendTitleFor(sendTitleOn(where, usable, c, blocked, left), enters)} disabled={blocked || off || left || sending ||"));
  assert.ok(choices.includes("const gone = useStore((s) => !!s.gone[c.id]);") && choices.includes("const line = toolbarLine(w, usable, c, gone);"));
  assert.ok(!composer.includes("sendGone") && !core("logic/chatserver.ts").includes("sendGone"));
});

// ---- a section's chat: the composer, its Send and its images

test("a section's chat before its first message has the composer of any chat: its server named and fixed, its agent, folder, model, effort and subagents open", () => {
  // the folder is open until the first message, and is that server's; nothing is open while the chat takes no change
  assert.ok(toolbar.includes("const folderOpen = !frozen && (!c.locked || !!c.folderMissing);"));
  assert.ok(toolbar.includes("<DirPicker cwd={c.cwd} missing={c.folderMissing} locked={!folderOpen} server={where.server} onPick={(d) => api.configure(c.id, shownBranch(getState(), c.id), { cwd: d })}"));
});

test("the first message of a section's chat is an ordinary Send: the same call as any message, on its branch", async () => {
  // the composer sends every message so, whatever the chat's server and whether it has started: no call of its own for a first message
  assert.equal(count(composer, /api\.send\(/g), 1, "one call in the whole composer: composer/send.ts");
  assert.ok(file("screens/composer/send.ts").includes("sendAt(chat, (branch, target) => api.send(chat, branch, text, context, references, target, images),"));
  assert.ok(!/c\?\.server && !c\.locked/.test(composer));
  // and its saver is told of it as of any Send: nothing is held
  assert.ok(composerTsx.includes("answered = getState().moves[chatId] ? null : drafts.current!.sending();"));
});

test("a first message with no answer: it is not known whether it arrived, and the page keeps the text", async () => {
  const parts: [string, string][] = [["the composer", composer], ["ChatChoices.tsx", choices], ["the chat view", chatView], ["logic/chatserver.ts", core("logic/chatserver.ts")], ["logic/sendend.ts", core("logic/sendend.ts")],
    ["logic/drafts.ts", core("logic/drafts.ts")], ["state/store.ts", core("state/store.ts")], ["types.ts", core("types.ts").slice(core("types.ts").indexOf("export type ChatView"), core("types.ts").indexOf("export type BranchState"))]];
  for (const [f, text] of parts) for (const gone of ["sent only once", "unconfirmed", "first_text_kept", "unmoved", "moveError"]) assert.ok(!text.includes(gone), `${f} has ${gone}`);
});

test("a server that is not connected: the Send is off for every chat of it, started or not, and the box is read-only (it keeps what it holds and takes no more)", () => {
  // Send's button and Enter read the server's state, and the box is locked by it
  assert.ok(composerTsx.includes("const off = sendOff(where);"));
  assert.ok(composerTsx.includes("const left = useStore((s) => !!s.gone[chatId]);"));
  assert.ok(composerTsx.includes("if ((!t && !quotes.length && !images.length) || blocked || off || left || sending || isSending(chatId)) return;"));
  assert.ok(composerTsx.includes("disabled={blocked || off || left || sending || (!text.trim() && !quotes.length && !images.length)}"));
  assert.ok(composerTsx.includes("const readOnly = boxOff(where, left);"));
  assert.ok(composerTsx.includes("<ChipInput ref={input} placeholder={placeholder} locked={readOnly} readOnly={readOnly}"), "the box takes no reference, no insert and no chip removal, and is not editable");
  // nothing is typed, pasted, dropped or deleted while it is read-only: the input is stopped at the box
  const box = file("platform/chipinput/ChipInput.web.tsx");
  assert.ok(box.includes("if (!(locked || readOnly) || !el) return;") && box.includes("now.current.locked || now.current.readOnly"));
  assert.ok(composerTsx.includes("onRemove={readOnly ? undefined : (id) => setImages((now) => withoutImages(now, [id]))}"), "no image leaves a draft that cannot be saved");
  assert.ok(composerTsx.includes("const canRef = !!board && !archived && !legacy && !readOnly && onScreen === board;"));
  // the chip input: locked, nothing is put in and nothing is taken out by its own code
  for (const line of ["if (!el || now.current.locked || now.current.readOnly) return;", "if (!locked && !readOnly && (key.key === \"Backspace\" || key.key === \"Delete\")", "if (copyValue(e) && !locked && !readOnly)",
    'contentEditable={readOnly ? "false" : "plaintext-only"}', "aria-readonly={readOnly || undefined}"]) assert.ok(box.includes(line), line);
});

test("the images of a section's chat go by the calls of a local chat: the upload, the fetch, the draft save and the Send, each to the chat's own address on its entry's server", async () => {
  assert.equal(count(composer, /addImages\(/g), 1, "the one place that calls it");
  assert.equal(count(composerTsx, /imagesOff\(/g), 1, "the one place that reads the chat's server for its images says why none can be added");
  // the files that hold a draft's images and the uploads ask nothing of the chat's server; the screens give a picture its server and chat (the transport's picture(), C6)
  for (const f of ["state/uploads.ts", "state/chatdraft.ts", "logic/messageimages.ts", "logic/drafts.ts"]) {
    assert.ok(!/serverOf|inSection|LOCAL_SERVER|[a-z]\.server\b|\/api\/on/.test(core(f)), `${f} asks for the chat's server`);
  }
  // the strip and a sent message fetch an image from the same address, whichever server the chat is on
  assert.ok(file("screens/composerimages/ImageStrip.tsx").includes("uri={previewOf(chat, x.id)}") && file("screens/composerimages/ImageStrip.tsx").includes("<ImageThumb key={x.id} server={at.server} chat={at.id} image={x.id}"));
  assert.ok(file("screens/images/MessageImages.tsx").includes("<ImageThumb key={`${i}:${im.id}`} server={im.server} chat={im.chat} image={im.id}"));
});

test("a server that is not connected, or that no longer has the chat: paste of an image and the attach button are off, with the reason; the images a draft has stay, and nothing is uploaded", () => {
  // a chat that is gone from its server takes none either: the composer says that in the place of the server's state
  assert.ok(composerTsx.includes("const noAdd = left ? { line: goneText(where.name), title: goneText(where.name) } : imagesOff({ server: where.name, connected: where.connected, model: noImages });"));
  // the composer asks before it uploads: the button is disabled with the tooltip, and a file that came by a paste goes to the check with the reason,
  // which refuses it there (uploads.ts addImages: no upload is started, and the error line names the file)
  assert.ok(composerTsx.includes("<parts.AttachButton off={noAdd?.title ?? \"\"} onPress={attach} />"));
  assert.ok(composerTsx.includes("addImages(chatId, branch, files, { has: held().images, off: noAdd?.line, skipped });"));
  // the strip is drawn from what the composer holds, whatever the server's state; while the composer is read-only no image leaves the draft. An
  // image that cannot be fetched is the plain tile (ImageThumb), and is fetched again when the server is back
  const strip = file("screens/composerimages/ImageStrip.tsx"), thumb = file("screens/images/ImageThumb.tsx");
  assert.ok(composerTsx.includes("note={up.uploads.length ? \"\" : imagesHeld} again={where.connected}"));
  assert.ok(strip.includes("again={again}") && strip.includes("onRemove={onRemove ? () => onRemove(x.id) : undefined}"), "with no remove given, a thumbnail has no remove control");
  assert.ok(thumb.includes("useEffect(() => { setBroken(false); }, [again, uri, image]);"), "the thumbnail is fetched again when the server is back");
  assert.ok(file("screens/chat/ItemView.tsx").includes("again={connected}") || dir("screens/chat").includes("again={"), "a sent message's images too");
  assert.ok(composerTsx.includes("const imagesHeld = imagesHold(images, up.uploads.length > 0, noImages);"));
});

test("a Send that fails, or whose arrival is not known, keeps the images with the text: in the composer and as the draft", async () => {
  // what the composer does with them
  assert.ok(composerTsx.includes("const p = picked, qs = quotes, im = images;"));
  assert.ok(composerTsx.includes("const back = withoutImages(im, lost.map((x) => x.id));"));
  assert.ok(composerTsx.includes("setImages((now) => withImages(back, now)); // and the images, before the ones added meanwhile"));
  assert.ok(composerTsx.includes("if (gone.current && !sendFailed(chatId, branch, { text: t, mentions: p, references: qs, images: back }, e)) drafts.current!.change(t, p, qs, back);"));
});

test("a Send refused because the chat's server no longer holds an image: that image stays out, the others go back, and the line says what to add again", async () => {
  assert.ok(composerTsx.includes("if (!gone.current) imagesGone(chatId, branch, lost);"));
});

test("every answer of the servers to a Send with images that was not taken: the text and the images go back, but for those the answer says the chat no longer holds, and the page knows whether anything was sent and whether to read the chat again", async () => {
  // what tells the composer that nothing was sent: any refusal below 500, and the 503 of a server that is not connected
  assert.ok(composerTsx.includes("refused = e instanceof ApiError && sentNothing(e.status, e.code);"));
});

test("the line under the composer is a refusal's own sentence, else the chat's error", () => {
  // (the refusal's sentence comes with what the uploads say of the images)
  assert.ok(composerTsx.includes('const under = underComposer([err, up.error].filter(Boolean).join(" "), c);') && composerTsx.includes("{under ? <Text {...tid(\"composer-err\")}"));
});

// ---- images in a chat's composer

test("a chat's composer takes pasted images and has the attach button", () => {
  const strip = dir("screens/composerimages"), box = file("platform/chipinput/ChipInput.web.tsx");
  // both ways go through the one check
  assert.ok(composerTsx.includes("onImages={parts.ImageStrip ? (files) => add(files) : undefined}"));
  assert.ok(/pick\(\)\.then\(\(r\) => \{ if \(r\.files\.length \|\| r\.skipped\.length\) add\(r\.files, r\.skipped\)/.test(composerTsx) || composerTsx.includes("add(r.files, r.skipped)"));
  assert.ok(composerTsx.includes("addImages(chatId, branch, files, { has: held().images, off: noAdd?.line, skipped });"));
  assert.equal(count(composer, /addImages\(/g), 1, "the one place that calls it");
  // and both are off for the same reason, which the button's tooltip and the refusal of a pasted file say (imagesOff)
  assert.ok(composerTsx.includes("const noAdd = left ? { line: goneText(where.name), title: goneText(where.name) } : imagesOff({ server: where.name, connected: where.connected, model: noImages });"));
  assert.ok(!composer.includes("unmoved") && !core("logic/chatimage.ts").includes("unmoved"));
  assert.ok(composerTsx.includes("<parts.AttachButton off={noAdd?.title ?? \"\"} onPress={attach} />"));
  assert.ok(strip.includes("Add images") && /disabled=\{!!off\}/.test(strip));
  // the box asks the paste rule only where images are taken, and a paste of images is consumed
  assert.ok(box.includes("onImages") && /preventDefault\(\)/.test(box));
});

test("the composer's Send: enabled with images alone, held by imagesHold, and the images go out with the message and back when it fails", () => {
  assert.ok(composerTsx.includes("if ((!t && !quotes.length && !images.length) || blocked || off || left || sending || isSending(chatId)) return;"));
  assert.ok(composerTsx.includes("if (imagesHold(images, slotOf(chatId, branch).uploads.length > 0, noImages)) return;"));
  assert.ok(composerTsx.includes("const imagesHeld = imagesHold(images, up.uploads.length > 0, noImages);"));
  assert.ok(composerTsx.includes("imagesHeld && !blocked && !off && !left ? <SendButton title={imagesHeld} disabled />"));
  assert.ok(composerTsx.includes("await sendMessage(chatId, t, p, toSend(qs), im);"));
  assert.ok(file("screens/composer/send.ts").includes("api.send(chat, branch, text, context, references, target, images)"), "the images go out with the message by the one api.send");
  // a refused Send that names images the chat no longer holds: those stay out, and the line says what to add again
  assert.ok(composerTsx.includes("const lost = e instanceof ApiError && e.images?.length ? im.filter((x) => e.images!.includes(x.id)) : [];"));
  assert.ok(composerTsx.includes("if (!gone.current) imagesGone(chatId, branch, lost);"));
  // the model rule looks at the model the message goes to: the one chosen for a pending move's new branch, else the chat's
  assert.ok(composerTsx.includes("const v = shownView(s, chatId), id = s.moves[chatId]?.model ?? v?.model;"));
  assert.ok(composerTsx.includes('return m?.noImages ? m.label || m.id : "";'));
});

// ---- the draft: when the box appears, what a Send does with the saver

test("the composer shows the text it holds when its box appears, takes a save's answer and a stale one by their counters, ends its Send for the saver whatever is thrown, and puts back by what the saver tells", () => {
  assert.ok(composerTsx.includes('import { draftToShow, saveDraft } from "@aiwb/core/state/chatdraft.ts";') && composerTsx.includes("saveDraft(chatId, branch, d, keepalive, base)"));
  // D3: after an unarchive the box has the composer's text when there is no draft to show
  assert.ok(composerTsx.includes("    const d = draftToShow(chatId, branch), t = boxText(d, current.current);\n    if (t !== null) input.current?.set(t);\n    if (!hasDraft(d)) return;"));
  // D4: the saver is told of the Send inside the try, and nothing that can throw stands between the two
  assert.ok(composerTsx.includes("    try {\n      answered = getState().moves[chatId] ? null : drafts.current!.sending();"));
  assert.equal(composerTsx.split(".sending(").length, 2);
  assert.ok(composerTsx.includes("    } finally {\n      answered?.(refused); setSending(false);"));
  // D1: the Send is ended before anything goes back, and nothing goes back when the saver tells of a removal
  const at = (t: string) => { const i = composerTsx.indexOf(t); assert.ok(i >= 0, t); return i; };
  const ended = at("const removed = answered?.(refused) ?? false;\n      answered = null;\n      if (putsBack(removed)) {");
  const closed = at("      }\n      // The chat is read again when its state here is stale");
  for (const t of ["setQuotes((now) => mergeQuotes(qs, now));", "setImages((now) => withImages(back, now));", "if (!current.current.trim()) input.current?.set(t);", "!current.current.trim()) setBox(t);", "drafts.current!.change(t, p, qs, back);"]) {
    assert.ok(at(t) > ended && at(t) < closed && composerTsx.indexOf(t, at(t) + 1) < 0, t);
  }
  // D4: a composer that went away is known as gone: its failed Send goes to the saver, not to a box
  assert.ok(composerTsx.includes("    return () => {\n      gone.current = true;\n      off();"));
  assert.ok(composerTsx.includes("    const off = onLeaving(hide);\n    gone.current = false;"));
});

test("the composer sets a text also when it draws no box (an archived chat), puts a refused Send's text back so, and tells its saver of a refusal", () => {
  // a draft from the server, and what a move sets: with no box the text is what the composer holds all the same
  assert.ok(composerTsx.includes("    if (input.current) input.current.set(t);\n    else { current.current = t; setText(t); }"));
  assert.ok(composerTsx.includes("      setBox(d.text);\n      setPicked(d.mentions ?? []);"));
  assert.ok(composerTsx.includes("if (h.text !== current.current) { setBox(h.text); input.current?.focus(true); }"));
  // a Send refused while the chat was archived: the composer is still there, without a box
  assert.ok(composerTsx.includes("if (!gone.current && !input.current && !current.current.trim()) setBox(t);"));
  assert.ok(composerTsx.includes("if (gone.current && !sendFailed(chatId, branch, { text: t, mentions: p, references: qs, images: back }, e)) drafts.current!.change(t, p, qs, back);"));
  // the first message of a chat on another server is a Send as any other: nothing is held for it, and a refusal is told
  assert.ok(composerTsx.includes("drafts.current!.sending();") && !composerTsx.includes("drafts.current!.kept()"));
  assert.ok(composerTsx.includes("refused = e instanceof ApiError && sentNothing(e.status, e.code);"));
  assert.ok(composerTsx.includes("answered?.(refused); setSending(false);"));
});

test("the page: conn.ts tells of `hello`, of a stream's snapshot and of a section's tree, and each composer adds its saver while it is open", () => {
  const conn = core("state/conn.ts");
  assert.ok(/case "hello": [^\n]*draftBacks\.opened\(\);/.test(conn));
  assert.equal(conn.split("draftBacks.snapshot();").length, 2);
  // a `section` event with a tree, and a snapshot that has the section: after the tree is in the store, never for a tree that went
  const on = conn.slice(conn.indexOf("function onSection(server: string, tree: SectionTree | null) {"), conn.indexOf("export function dropLeft()"));
  assert.match(on, /const left = applySection\(server, tree\);[\s\S]*if \(!tree\) \{ givenUp\(server\); return; \}[\s\S]*draftBacks\.sectionBack\(server\);\n\}/);
  assert.equal(conn.split("draftBacks.sectionBack(").length, 2);
  assert.ok(!conn.includes("server_back") && !conn.includes("chat_reload") && !conn.includes("serverBack("));
  assert.ok(composerTsx.includes("useEffect(() => draftBacks.add({ server: () => on.current, back: () => drafts.current!.back() }), []);"));
  assert.ok(composerTsx.includes("on.current = where.server;"), "the server is the chat's as the composer reads it: the one its key names");
});

test("the page closes during an upload: the draft that is saved, and the copy the browser keeps, are without the image", async () => {
  // What the composer saves as the page goes away is what it holds, and an upload that runs is no part of that until it is answered.
  assert.ok(composerTsx.includes("    const hide = () => {\n      now.current.quotes = q.kept();\n      const h = leftByBack(chatId, branch);\n      if (h) save(h);\n      else if (!getState().moves[chatId]) save(held());\n      d.flush(true);\n    };\n    const off = onLeaving(hide);"));
  assert.ok(composerTsx.includes("images: put.current?.images ?? now.current.images });"));
  assert.ok(composerTsx.includes("const [images, setImages] = useState<ChatImage[]>(() => draftToShow(chatId, branch)?.images ?? []);"));
});

// ---- the end of a Send

test("the refusals of the move that carried a chat over to its server are gone with it", () => {
  const logic = core("logic/sendend.ts");
  for (const gone of ["NOT_MOVED", "MOVE_REFUSED", "not_moved", "move_refused", "moveError", "unmoved"]) {
    assert.ok(!logic.includes(gone), `logic/sendend.ts has ${gone}`);
    assert.ok(!composer.includes(gone), `the composer has ${gone}`);
  }
});

test("underComposer: the last refusal's sentence, else the chat's own error, and nothing else", () => {
  assert.ok(composerTsx.includes('const under = underComposer([err, up.error].filter(Boolean).join(" "), c);'));
});

test("the composer shows a refusal by refusalShown, and nothing stands in the thread's place for a message on its way", () => {
  for (const text of [composer, chatView, core("state/store.ts")]) assert.ok(!text.includes("startingAfter") && !text.includes("STARTING_LINGER") && !/\bstarting[:\[]/.test(text));
  // the server's state is read from the store as the answer is handled, not as the Send began
  assert.ok(composerTsx.includes("if (refusalShown(e instanceof ApiError ? e.status : undefined, code, serverConnected(getState(), where.server))) setErr("));
  assert.ok(composerTsx.includes("if (putsBack(removed)) {"));
  // whether the saver is told that the message was not taken
  assert.ok(composerTsx.includes("refused = e instanceof ApiError && sentNothing(e.status, e.code); // (a 5xx may hide a message that was taken)"));
});

// ---- the shell: the board taken on a select, where a new chat is made, the menus

test("selecting a board never takes it: select, a chat's row, a board's row and the board's bar ask nothing of the server; making a board takes it", () => {
  const select = nav.slice(nav.indexOf("export function select("), nav.indexOf("/** Opens a board with the last chat"));
  assert.ok(!/take|ifFree/i.test(select), "select asks for no board");
  assert.ok(!nav.includes("takeOnSelect") && !nav.includes("ifFree") && !/row = false|o\.row|\{ row \}/.test(nav), "no take decision, no row");
  assert.ok(/export function openChat\(c: ChatView\): void \{\s+select\(selOf\(c\)\);/.test(nav), "a chat's row and a chat reference");
  assert.ok(nav.includes("export function openBoard(id: string, withChat") && /select\(\{ board: id, chat: withChat \? [^\n]*\}\);/.test(nav));
  // making a board is the one explicit take outside the button (D12)
  assert.ok(/upsertBoard\(b\);\s+select\(\{ board: b\.id, chat: null \}\);\s+void boardApp\.takeBoard\(b\.id\);/.test(nav), "newBoard takes the board it made");
  assert.equal(count(nav, /takeBoard\(/g), 1);
});

test("the one take in the screens is the button of the reader's bar; the canvas takes nothing and shows for every role", () => {
  const canvas = file("screens/board/BoardCanvas.tsx"), bar = file("screens/board/RoleBar.tsx");
  assert.ok(!canvas.includes("takeBoard") && !canvas.includes("showsPanel") && !canvas.includes("TakeoverPanel"));
  assert.ok(canvas.includes("const wanted = known && off === \"canvas\" && !err;"), "the canvas is wanted whatever the role");
  const all = ["board", "shell", "sidebar", "chat", "composer"].map((d) => dir(`screens/${d}`)).join("\n");
  assert.equal(count(all, /\.takeBoard\(/g), 2, "the bar's button, and newBoard");
  assert.ok(bar.includes("void boardApp.takeBoard(board);") && bar.includes('{...tid("board-take")}') && !bar.includes("ifFree"));
  assert.ok(!fs.existsSync(path.join(appSrc, "screens/board/TakeoverPanel.tsx")));
});

test("a reload of the board on screen (its scene kept was dropped) does not hide it first", () => {
  const canvas = file("screens/board/BoardCanvas.tsx");
  const first = canvas.slice(canvas.indexOf("owner = me;"), canvas.indexOf("}, [board, wanted, channel]);"));
  assert.ok(first.includes("boardApp.hide()"));
  assert.ok(canvas.includes("}, [board, wanted, channel]);") && !/\[[^\]]*\bgen\b[^\]]*\]\);\n\n  \/\/ The scene kept/.test(canvas) && canvas.includes("}, [gen]);"));
  const second = canvas.slice(canvas.indexOf("// The scene kept for the board was dropped"), canvas.indexOf("}, [gen]);"));
  assert.ok(second.includes("ask(") && !second.includes("hide()"), "the second effect only asks again");
});

test("only the board's own row in the sidebar opens it as a row click", () => {
  // a board's row (screens/sidebar/rows.tsx), the side rail's list of boards (screens/shell/slots.tsx) and the board's bar open a board with its chat or alone;
  // a reference to a board takes its own default
  assert.equal(count(dir("screens/sidebar"), /openBoard\(b\.id\)/g), 1);
  assert.equal(count(file("screens/shell/slots.tsx"), /openBoard\(key\)/g), 1);
  assert.ok(file("screens/shell/BoardBar.tsx").includes("openBoard(board, true)"), "the board's bar");
  for (const [name, text] of [["the markdown", dir("screens/markdown")], ["the chat view", chatView]] as const) assert.ok(!/openBoard\([^)]*,/.test(text), `${name}: a reference to a board has no second argument`);
  assert.ok(file("screens/chat/env.ts").includes("openBoard: (id) => openBoard(id),"), "a reference to a board in a message");
});

test("the composer's chip takes its count from selectedOn, with the role of the chat's board", () => {
  assert.ok(composerTsx.includes("const role = useStore((s) => (c?.board ? s.roles[c.board] : undefined));"));
  assert.ok(composerTsx.includes("const selected = canRef ? selectedOn(selection.count, board, onScreen, role) : 0;"));
});

test("the places that make a chat have no agent menu and name no agent", () => {
  const files = { sidebar: dir("screens/sidebar"), shell: dir("screens/shell") };
  for (const [f, text] of Object.entries(files)) {
    assert.ok(!text.includes("AgentItems"), `${f} has AgentItems`);
    assert.ok(!/newChat\(\s*["'`a]\s*[,"'`]/.test(text) && !text.includes('newChat("'), `${f} gives newChat an agent`);
    assert.ok(!text.includes("AGENT_ORDER"), `${f} lists the agents`);
  }
  // the places: the top "+", a section's "+", a group's "+", a board row's, the board bar, the empty state
  assert.equal(count(files.sidebar, /void newChat\(\{ group: UNGROUPED \}\)/g), 1);
  assert.equal(count(files.sidebar, /void newChat\(\{ group: loose \}\)/g), 1); // a section's head: outside any group, on that server
  assert.ok(files.sidebar.includes("const loose = ungroupedOn(v.id);"));
  assert.equal(count(files.sidebar, /void newChat\(\{ group: g\.id \}\)/g), 1);
  assert.equal(count(files.sidebar, /void newChat\(\{ board: b\.id \}\)/g), 1);
  assert.equal(count(files.shell, /void newChat\(\{ board \}\)/g), 1);
  assert.equal(count(files.shell, /void newChat\(\{ group: UNGROUPED \}\)/g), 1);
  // and ⌘N, which makes one where the user is, if that place offers one (logic/newchatwhere.ts)
  assert.ok(file("screens/shell/shortcuts.ts").includes("if (where) acts.newChat(where);"));
  assert.ok(file("screens/shell/useShortcuts.ts").includes("newChat: (where) => void newChat(where)"));
  // no place asks where the chat should live, and none names a server: the place's key says it
  for (const [f, text] of Object.entries(files)) assert.ok(!/newChat\(\{[^}]*server/.test(text) && !text.includes("BoardChoice") && !text.includes("Where should this live"), f);
});

test("the two menus still offer a chat and a whiteboard", () => {
  const side = dir("screens/sidebar");
  for (const label of ['label="New chat"', 'label="New whiteboard"', 'label="New group"']) assert.ok(side.includes(label), label);
  for (const label of ['label="Chat"', 'label="Whiteboard"', 'label="Group"']) assert.ok(side.includes(label), label);
  const home = dir("screens/shell");
  for (const label of ['label="New chat"', 'label="New whiteboard"', "homeAgentsText("]) assert.ok(home.includes(label), label);
  assert.ok(!home.includes("Claude Code, Cursor or pi"), "the empty state names fixed agents");
});

test("the place asks the store whether the place is reachable, by the place's own key", () => {
  // the page hands ⌘N every group it knows, and the rule of logic/sections.ts
  const shortcuts = file("screens/shell/useShortcuts.ts") + file("screens/shell/shortcuts.ts");
  assert.ok(/newChatPlace\(\{[^\n]*reachable: \(key\) => reachable\(/.test(shortcuts) || shortcuts.includes("reachable"), "the shortcut's place is reachable by its key");
});

// ---- the folder hint, the sidebar's sections and rows, the chat view, the Servers dialog, the subagents

test("the folder hint gives folderAgents the chats and their records alone, and the composer shows none", () => {
  const hint = file("screens/fork/FolderHint.tsx");
  assert.equal(hint.split("folderAgents({").length - 1, 1);
  assert.ok(hint.includes("folderAgents({ chats, states: allStates(chats, states), cwd, chat: chatId })"));
  // the chip beside the composer's folder ("N others working here") is gone
  assert.doesNotMatch(composer, /FolderHint|working here/);
});

test("the sidebar draws every section, this computer's too, with the one tree: each from the groups of its own server", () => {
  const section = file("screens/sidebar/Section.tsx"), side = dir("screens/sidebar");
  assert.ok(section.includes("const tree = held && groups ? buildTree({ groups, boards, chats }, showArchived, { server: v.id, gone }) : null;"));
  assert.ok(section.includes("const view = sectionView(v, !!tree, empty, archived);"));
  assert.ok(section.includes("const count = tree ? treeCount(tree) : 0;"));
  assert.equal(side.split("buildTree(").length, 2, "one tree for every section, and no second");
});

test("the chat view reads the three from the chat's key, the section's tree and the page's mark", () => {
  const thread = file("screens/chat/Thread.tsx");
  assert.ok(thread.includes("const remote = remoteView({ connected, gone }, serverIs, state, !!loaded || !!wait.kept, loadErr);"));
  assert.ok(thread.includes("const connected = useStore((s) => serverConnected(s, server));"));
  assert.ok(thread.includes("const gone = useStore((s) => !!s.gone[chatId]);"));
  assert.ok(file("screens/chat/Remote.tsx").includes("{!gone && <Button {...tid(\"remote-servers\")} label={SERVERS} tone=\"ghost\" size=\"sm\" onPress={() => openServers()} />}"));
});

test("deleteAsk: the dialog a chat's Delete opens", () => {
  // the sidebar names the server of a section's chat alone
  assert.ok(sidebarActions.includes('const there = (key: string): string => (inSection(key) ? serverName(getState(), serverOfKey(key)) : "");'));
  assert.ok(sidebarActions.includes("const ask = deleteAsk(chatTitle(c, threadOf(getState(), c.id)?.items), there(c.id));"));
});

test("a chat is deleted on its server or not at all: nothing offers to remove it from this sidebar only", () => {
  const logic = core("logic/remoteview.ts"), side = dir("screens/sidebar");
  for (const gone of ["REMOVE_ONLY", "offersLocalOnly", "deleteRefused", "staysText", "this sidebar"]) {
    assert.ok(!logic.includes(gone), `logic/remoteview.ts has ${gone}`);
    assert.ok(!side.includes(gone), `the sidebar has ${gone}`);
  }
});

test("the question before a removal asks the server for nothing: the entry is removed, and that server is told nothing", () => {
  // This app keeps nothing of that server but the entry, so there is nothing to count: no call is made before the question.
  const row = file("screens/servers/ServerRow.tsx");
  assert.ok(row.includes('title: "Remove server", body: removeText(v.name),'));
  const remove = row.slice(row.indexOf("title: \"Remove server\""), row.indexOf("title: \"Remove server\"") + 300);
  assert.ok(remove.length > 0 && !remove.includes("await serversApi.items") && !remove.includes("getState()") && !remove.includes("chats"), "nothing is counted on the page or by the local server");
  assert.ok(remove.includes('actions: [{ label: "Remove", tone: "danger", run: async () => { await serversApi.remove(v.id); entryRemoved(v.id); } }],'));
  assert.ok(!dir("screens/servers").includes("serversApi.items") && !dir("screens/servers").includes(".items("));
});

test("the chat's header takes its status from headStatus, and draws no separator for none", () => {
  const header = file("screens/chat/Header.tsx");
  assert.ok(header.includes("const frozen = sendOff(where) || gone;"));
  assert.ok(header.includes("const status = headStatus(c, isLegacy(c), statusText(c, boardNames(chatId), now), frozen);"));
  assert.ok(header.includes('{status ? <>{" · "}{status}</> : null}'));
});

test("boardDeleteBody: the question before a board is deleted; a section's is removed on its server, for everyone who uses it", () => {
  assert.ok(sidebarActions.includes("body: boardDeleteBody(busy.length > 0, there(b.id)),"));
  assert.ok(sidebarActions.includes('actions: [{ label: "Delete", tone: "danger", run: async () => { await stopAll(busy); await boardApp.flush(b.id); await api.deleteBoard(b.id); } }],'));
});

test("the sidebar's board row: the menu by the board's key, the targets from the groups of the board's own server, and no server after the name", () => {
  const rows = file("screens/sidebar/rows.tsx");
  assert.ok(rows.includes("const groups = useStore((s) => groupsOn(s, serverOf(b)));"), "the groups of the board's own server, and of no other");
  assert.ok(rows.includes(`const targets = moveTargets(groups, b.group).map((g) => ({ label: g.label, run: () => attempt("Couldn't move the board", () => api.moveBoard(b.id, g.id)) }));`));
  assert.ok(rows.includes('const menu = boardMenu(b).filter((i) => i !== "move" || targets.length > 0)'), "no Move to… with nowhere to move to");
  assert.ok(rows.includes("reveal: () => attempt(\"Couldn't reveal the board\", () => boardApp.flush(b.id).then(() => api.reveal(b.id))),"));
  // a row inside a section carries no server name: the section says it
  const side = dir("screens/sidebar");
  for (const gone of ["BoardTag", "board-tag", "boardRow(", "remoteRow("]) assert.ok(!side.includes(gone), gone);
  for (const f of ["BoardTag.tsx", "BoardChoice.tsx"]) assert.equal(fs.existsSync(path.join(appSrc, "screens/sidebar", f)), false, f);
  assert.equal(fs.existsSync(path.join(coreSrc, "logic/boarddraft.ts")), false);
  // the chat's choices read the server from the chat's own key, not from its board
  assert.ok(choices.includes("const fixed = serverFixed(c);"));
  assert.ok(!choices.includes("s.boards[c.board]?.server") && !choices.includes("serverOnBoard"));
});

test("a subagent's model is named by the catalog of its chat's server", () => {
  const row = file("screens/subagents/Row.tsx"), drawer = file("screens/subagents/Drawer.tsx"), parts = file("screens/subagents/Parts.tsx");
  assert.equal(row.split("const server = serverOf(chat);").length + drawer.split("const server = serverOf(chat);").length, 4, "the row and the drawer");
  assert.equal(row.split("<SubStats sa={sa} items={items} now={now} server={server}").length + drawer.split("<SubStats sa={sa} items={items} now={now} server={server}").length, 4);
  assert.doesNotMatch(row + drawer + parts, /serverOfChat/);
  assert.match(parts, /const cat = useStore\(\(s\) => catalogFor\(s, server, sa\.kind \?\? ""\)\);/);
});

test("the page starts watching before its stream opens, and conn.ts tells draftBacks of this computer's stream `hello`, of its snapshot and of a section's tree", () => {
  const main = file("bootstrap.ts"), connSrc = core("state/conn.ts");
  assert.ok(main.indexOf("watchKeptDrafts();") > 0 && main.indexOf("watchKeptDrafts();") < main.indexOf("connect();"));
  assert.ok(/case "hello": [^\n]*if \(!on\) \{[^\n]*draftBacks\.opened\(\); \}/.test(connSrc), "this computer's hello alone: drafts of its chats");
  assert.ok(/function onSnapshot\(m: any\) \{\n(?:  .*\n)*?  applySnapshot\(m, dropMoves\(\)\);\n(?:  .*\n)*?  draftBacks\.snapshot\(\);\n\}/.test(connSrc), "after this computer's snapshot is in the store");
  assert.ok(/function onSection\(server: string, tree: SectionTree \| null\) \{[\s\S]*?if \(!tree\) \{ givenUp\(server\); return; \}[\s\S]*?draftBacks\.sectionBack\(server\);\n\}/.test(connSrc), "of a tree, and not of none");
});

// ---- the board: the banner and the view in the canvas's place, read from the section's tree and the page's mark

test("a save answered 503 not_held_there (the board is being taken again on its server) is \"not yet\": the edit is kept under the banner, which does not say that the server is unreachable", () => {
  // the banner reads whether the server is connected from the section's tree, and the held event writes the edit that waits
  const off = file("screens/board/BoardOff.tsx"), side = core("board/side.ts");
  assert.ok(off.includes("const connected = useStore((s) => serverConnected(s, serverOfKey(board)));") && off.includes("bannerText(name, connected)"));
  assert.ok(side.includes("if (saveOutage(status)) setOutage(id, true);"));
  assert.ok(side.includes("step(id, onGrant(cacheOf(id), rev));"), "a held event saves the kept edit at its revision, and drops it at another");
  assert.ok(side.includes("step(id, onLost(cacheOf(id), waitsForServer(id)));"), "superseded keeps an edit that waits for the board's server");
});

test("a save of a board that is refused for another reason than an outage (413 too_large, 502 bad_answer): the edit is kept, and the canvas says the server's sentence", () => {
  const off = file("screens/board/BoardOff.tsx"), side = core("board/side.ts");
  assert.ok(side.includes("setSaveSaid(id, saveRefusal(status, code, e instanceof Error ? e.message : String(e), e instanceof ApiError && e.said));"));
  assert.ok(off.includes('const said = useStore((s) => s.saveSaid[board] ?? "");') && off.includes("const text = said || (on ? bannerText(name, connected) : \"\");"));
});

test("the canvas reads the three from the board's key, the section's tree and the page's mark", () => {
  assert.ok(file("screens/board/BoardCanvas.tsx").includes("const off = boardView({ connected: connected && !away, gone }, boardApp.scene(board) !== undefined);"));
});

// ---- the calls of the sidebar and the chat view for a section's things

test("a rename of a section's chat that its server refuses, or does not answer, is said; the name is the one that server has", async () => {
  assert.ok(file("screens/chat/Header.tsx").includes("renameChat(chat, v.trim(), chatTitle(chat, items));"), "the name box renames through it");
  assert.ok(sidebarActions.includes('if (inSection(chat.id)) reportError("Couldn\'t rename the chat", e);'), "and the refusal of a section's server is said");
});

test("a Send to a section's chat that is answered 404 not_found says that the chat is no longer on that server", () => {
  assert.ok(composerTsx.includes("if (goneBySend(code) && getState().chats[chatId]) markGone(chatId);"));
});

test("the section's event with no tree is here first, as in an outage: the chat stays until the list says that the entry is gone, by the answer or by the event", async () => {
  assert.ok(file("screens/servers/ServerRow.tsx").includes('run: async () => { await serversApi.remove(v.id); entryRemoved(v.id); }'));
});

// ---- the Servers dialog

test("save and accept put their answer into the store through `answered` alone", () => {
  const text = dir("screens/servers");
  assert.equal(text.includes("upsertServer"), false);
  assert.equal((text.match(/answered\(a\?\.server\)/g) ?? []).length, 2);
});

test("Servers.tsx renders no HTML of its own making and no markdown", () => {
  const text = dir("screens/servers");
  assert.equal(text.includes("dangerouslySetInnerHTML"), false);
  assert.equal(/markdown/i.test(text), false);
  assert.equal(text.includes("innerHTML"), false);
});
