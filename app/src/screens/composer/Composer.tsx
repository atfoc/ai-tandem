// The message box under a chat, and its toolbar (the old page's Composer.tsx; AD-62). The pickers come from the server's catalogs and can be changed
// until the first message is sent: of a new chat, of a fork that has had none of its own, and of the branch a pending move starts.
// `Composer` is what the chat view draws (parts.tsx `Composer`): the composer of the branch the chat is on.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";

import { Sized } from "../../platform/sized";

import { api, ApiError } from "@aiwb/core/api.ts";
import { agentOpen, catalogFor, usableAgents } from "@aiwb/core/logic/agentlist.ts";
import { branchKey } from "@aiwb/core/logic/branches.ts";
import { boxOff, notConnectedLine, offPlaceholder, offWhy, sendOff, sendTitleOn } from "@aiwb/core/logic/chatserver.ts";
import { imagesHold, imagesOff, withImages, withoutImages } from "@aiwb/core/logic/chatimage.ts";
import { DraftSaver, boxText, hasDraft } from "@aiwb/core/logic/drafts.ts";
import { draftBacks } from "@aiwb/core/logic/draftsback.ts";
import { LIVE_FORK } from "@aiwb/core/logic/forkpoints.ts";
import { mentionOptions, openMention, resolveMentions, type Picked } from "@aiwb/core/logic/mentions.ts";
import { goneText } from "@aiwb/core/logic/remoteview.ts";
import { plainText } from "@aiwb/core/logic/refs.ts";
import { selectedOn } from "@aiwb/core/logic/roles.ts";
import { goneBySend, putsBack, refusalShown, sentNothing, underComposer } from "@aiwb/core/logic/sendend.ts";
import { serverConnected } from "@aiwb/core/logic/serverlists.ts";
import { composerControls, notConnected, refreshAfterRefusal } from "@aiwb/core/logic/status.ts";
import { mergeQuotes, toSend } from "@aiwb/core/logic/quotes.ts";
import { sendWait } from "@aiwb/core/logic/waits.ts";
import { isSending, leftByBack, registerComposer, sendFailed } from "@aiwb/core/state/actions.ts";
import { refreshChat } from "@aiwb/core/state/conn.ts";
import { draftToShow, saveDraft } from "@aiwb/core/state/chatdraft.ts";
import { boardsOn, branchState, getState, groupsOn, isLegacy, markGone, shownBranch, shownView, unsavedDraft, viewedBranch } from "@aiwb/core/state/store.ts";
import { addImages, imagesGone, setImageError, slotOf, subscribe as subscribeUploads } from "@aiwb/core/state/uploads.ts";
import type { AgentKind, ChatImage, Held, Reference } from "@aiwb/core/types.ts";

import { ChipInput, type ChipInputHandle } from "../../platform/chipinput/ChipInput";
import type { KeyLike } from "../../platform/keys.types.ts";
import { onKey as onKeyPort } from "../../platform/keys";
import { onLeaving } from "../../platform/leaving";
import { KeyboardLift } from "../../platform/keyboard";
import { useStore } from "../../state/useStore.ts";
import { agentName } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useWhere } from "../chat/hooks.ts";
import { onPhone } from "../board/phone.ts";
import { addSelection, composerGone, registerInserter, startPick, takeHeld } from "../board/refs.ts";
import { registerBox } from "./focus.ts";
import { boxAction, enterSends, keyNames, refKey, sendByKey, sendTitleFor } from "./keys.ts";
import { ArchivedBar, ContextRow, LegacyBar, ModelNotice } from "./Notices.tsx";
import { composerParts, useComposerParts } from "./parts.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { keyPlatform } from "../shell/keyplatform.ts";
import { MentionList } from "./Mention.tsx";
import { useEscLayer } from "../../ui/useEscLayer";
import { SendButton, StopButton } from "./Send.tsx";
import { sendMessage } from "./send.ts";

/** The chat whose composer had the focus as it went away for the composer of another branch (the chat is on that one now): the one that
 *  opens takes the focus, as if it were the same. */
let refocus: string | null = null;

/** Whether a dialog or a popup is open: ⌘Enter sends nothing under one (the library's edit form saves with it). */
const underDialog = () => {
  const s = getState();
  return !!(s.confirm || s.serversDialog || s.libraryDialog || s.insertPopup || s.treeNav);
};

/** The composer the chat view draws: the one of the branch the chat is on (another branch has another composer, with its own draft). */
export function Composer({ chat }: { chat: string }) {
  const branch = useStore((s) => viewedBranch(s, chat));
  return <ComposerOf key={branchKey(chat, branch)} chatId={chat} branch={branch} />;
}

/** The composer of one branch of a chat: `branch` is the one the chat is on, whose draft it holds.
 *  Images come in by a paste into the box and by the attach button of the toolbar's row (K4), both through one check (uploads.ts addImages),
 *  and stand as thumbnails above the text. The composer holds the uploaded ones, as part of its draft; the uploads that run are the branch's,
 *  and go on when the composer goes away. A chat of a section has the same composer and makes the same calls: its images are uploaded to, kept
 *  on and fetched from its server.
 *  While that server is not connected, or once it no longer has the chat, the composer is read-only and says why: nothing is sent, stopped or
 *  changed, and no image can be added (logic/chatimage.ts imagesOff; the images a draft has stay, with no remove control, and so do its
 *  quotes). The box is read-only too (logic/chatserver.ts boxOff): it keeps what it holds, and takes no typing, no paste and no drop; no prompt
 *  is inserted into it, and an archived chat is not unarchived from it. What was typed and not yet taken by the server stays in it, in the
 *  app's memory alone, and is saved when the server is connected again (logic/draftsback.ts), on the draft counter the app has then. */
function ComposerOf({ chatId, branch }: { chatId: string; branch: string }) {
  const { tokens: t } = useTheme();
  const parts = useComposerParts();
  const c = useStore((s) => shownView(s, chatId));
  const move = useStore((s) => !!s.moves[chatId]); // the next message starts a new branch
  const where = useWhere(c);
  const usable = useStore((s) => usableAgents(s, where.server)); // what a chat with no agent says depends on whether one can be chosen
  const boards = useStore((s) => boardsOn(s, where.server)); // what the chat can mention: the boards of its own server
  const groups = useStore((s) => groupsOn(s, where.server));
  const left = useStore((s) => !!s.gone[chatId]); // its server no longer has the chat
  const selection = useStore((s) => s.selection);
  const onScreen = useStore((s) => s.sel.board);
  const role = useStore((s) => (c?.board ? s.roles[c.board] : undefined));
  const picking = useStore((s) => s.picking === chatId);
  const waits = useStore((s) => s.waits[chatId]); // what is on its way in the chat: a composer opened again reads the same
  // The model the message goes to, when it takes no images: the chat's, or the one chosen for a pending move's new branch. "": it takes them.
  const noImages = useStore((s) => {
    const v = shownView(s, chatId), id = s.moves[chatId]?.model ?? v?.model;
    const m = v ? catalogFor(s, where.server, v.agent)?.models.find((x) => x.id === id) : undefined;
    return m?.noImages ? m.label || m.id : "";
  });
  const [text, setText] = useState(() => draftToShow(chatId, branch)?.text ?? "");
  const [picked, setPicked] = useState<Picked[]>(() => draftToShow(chatId, branch)?.mentions ?? []);
  const [quotes, setQuotes] = useState<Reference[]>(() => draftToShow(chatId, branch)?.references ?? []);
  const [images, setImages] = useState<ChatImage[]>(() => draftToShow(chatId, branch)?.images ?? []);
  const up = useUploads(chatId, branch); // the uploads that run for this branch, and what the error line says of the images
  const [mention, setMention] = useState<{ q: string; at: number; i: number } | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const input = useRef<ChipInputHandle>(null);
  const hasFocus = useRef(false);
  const current = useRef(text); // the text now, for a failed send
  const now = useRef({ picked, quotes, images }); // with it, what the composer holds (for a move)
  now.current = { picked, quotes, images };
  const put = useRef<{ picked: Picked[]; quotes: Reference[]; images: ChatImage[] } | null>(null); // what a move set that no render has shown yet: the composer may go away before one does
  const drafts = useRef<DraftSaver | null>(null);
  const gone = useRef(false); // this composer went away
  // Puts a text into the composer. An archived chat draws no box, and the text is then set as what the composer holds all the same: left as
  // it was, it would go to the saver as typed with the next change of the mentions or the quotes, and two windows would save their texts over
  // each other without end.
  const setBox = (t: string) => {
    if (input.current) input.current.set(t);
    else { current.current = t; setText(t); }
  };
  const draftRev = useStore((s) => branchState(s, chatId, branch)?.draftRev ?? 0);
  drafts.current ??= new DraftSaver((d, keepalive, base) => saveDraft(chatId, branch, d, keepalive, base), branchState(getState(), chatId, branch)?.draft, unsavedDraft(chatId, branch),
    undefined, draftRev, (d) => {
      if (getState().moves[chatId]) return; // the composer holds the move's message
      setBox(d.text);
      setPicked(d.mentions ?? []);
      setQuotes(d.references ?? []);
      setImages(d.images ?? []);
    });
  const board = c?.board;
  const archived = !!c?.archived;
  const legacy = isLegacy(c);
  // The chat is shown as it was and takes no change (its server is not connected, or no longer has it): the box is read-only, and so is
  // everything of the draft.
  const readOnly = boxOff(where, left);
  const canRef = !!board && !archived && !legacy && !readOnly && onScreen === board;
  const [width, setWidth] = useState(0); // the composer's, for the count of quotes (it leaves its word out when narrow)
  const q = parts.useQuotes({ chat: chatId, quotes, setQuotes, readOnly, width });
  const names = keyNames(keyPlatform());

  // ⌘L quotes the text selected in a message; with none, it puts the selection on the board into the message. ⌘⇧L waits for a point clicked
  // on the board. The board puts a reference into the box through the inserter the composer registers (screens/board/refs.ts).
  const addSelectionNow = () => {
    if (!board) return;
    setNote(addSelection(chatId, board)); // (the sentence to say when nothing is selected, "" when the selection went in through the inserter below)
  };
  const submitNow = useRef<() => void>(() => {});
  useEffect(() => {
    if (archived || legacy) return;
    const off = canRef ? registerInserter(chatId, (r, at) => { setNote(""); input.current?.insertRef(r, at); }, () => input.current?.caret() ?? null) : undefined;
    const k = (e: KeyLike) => {
      if (sendByKey(e, Platform.OS)) { // a hardware keyboard sends with ⌘Enter / Ctrl+Enter where Enter is a line break (keys.ts)
        if (underDialog() || getState().sel.chat !== chatId) return;
        e.preventDefault(); e.stopPropagation();
        submitNow.current();
        return;
      }
      const which = refKey(e);
      if (which !== "selection") return; // (⌘⇧L is the board's: screens/board/boardkeys.ts takes it, while a chat of the board in the panel takes a change)
      const sel = composerParts().quoteSelection(chatId);
      if (sel) {
        e.preventDefault(); e.stopPropagation();
        if (readOnly) setNote(left ? goneText(where.name) : notConnected(where.name)); // nothing is put into a draft that cannot be saved
        else if ("error" in sel) setNote(sel.error); else { setNote(""); q.quote(sel.ref, sel.at); }
        return;
      }
      if (!canRef) {
        if (!board) { e.preventDefault(); setNote("Select text in a message to quote it"); }
        return;
      }
      e.preventDefault(); e.stopPropagation();
      addSelectionNow();
    };
    const offKeys = onKeyPort(k);
    return () => {
      off?.();
      offKeys();
      composerGone(chatId); // (a wait for a point ends with its composer, except the phone's, which shows the board meanwhile)
    };
  }, [canRef, archived, legacy, chatId, readOnly, left, where.name]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(""), 2500); return () => clearTimeout(t); }, [note]);
  // A refusal's sentence is about the server's state and the chat's choices it was given in: it goes when the server is connected again, when
  // the chat starts, and when its agent, folder, model, effort or subagent settings change.
  useEffect(() => { if (where.connected) setErr(""); }, [where.connected]);
  useEffect(() => { setErr(""); }, [c?.locked, c?.agent, c?.cwd, c?.model, c?.effort, c?.subOff, c?.subDepth, c?.subCap]);

  // The draft: put into the box when it appears (on open, after unarchiving), saved as it changes, and saved at once when the composer or the
  // page goes away. A later draft from the server is put in only when it is newer than this composer's (another window saved it) and nothing
  // typed here waits to be saved: the saver tells (DraftSaver.arrived). With no draft to show, the box gets the text the composer holds: one
  // set while the chat was archived (setBox), which Enter would send unseen.
  useEffect(() => {
    if (c?.archived || isLegacy(c)) return;
    const d = draftToShow(chatId, branch), t = boxText(d, current.current);
    if (t !== null) input.current?.set(t);
    if (!hasDraft(d)) return;
    setPicked(d.mentions ?? []);
    setQuotes(d.references ?? []);
    setImages(d.images ?? []);
  }, [c?.archived, c?.instructionsSent]);
  // A point made while this box was away (the phone's wait: the board was shown, then this chat again) goes in now that the draft is in it, at the
  // caret the box had when the wait began.
  useEffect(() => {
    if (!canRef) return;
    for (const h of takeHeld(chatId)) {
      setNote("");
      if (!h.at) input.current?.focus(true); // (the box had no caret when the wait began: the end)
      input.current?.insertRef(h.ref, h.at);
    }
  }, [canRef, chatId]);
  useEffect(() => { drafts.current!.arrived(draftRev, branchState(getState(), chatId, branch)?.draft); }, [draftRev]);
  // A draft typed while its server was away is saved when that server is connected again (its section's tree arrives), and when the app's own
  // connection opens again (logic/draftsback.ts).
  const on = useRef(where.server);
  on.current = where.server;
  useEffect(() => draftBacks.add({ server: () => on.current, back: () => drafts.current!.back() }), []);
  // The typing goes on in the composer of the branch a sent move went to.
  useLayoutEffect(() => () => {
    const s = getState();
    if (s.sel.chat === chatId && viewedBranch(s, chatId) !== branch && hasFocus.current) refocus = chatId;
  }, []);
  useEffect(() => {
    if (refocus === chatId) input.current?.focus(true);
    refocus = null;
  }, []);
  useEffect(() => registerBox(chatId, { focus: (atEnd) => input.current?.focus(atEnd) }), [chatId]);
  // A move reads what the composer holds and puts into it what it takes back or restores. set gives fresh lists, so the draft is looked at
  // again also when nothing else changed. What it set is what the composer holds at once, also for one that goes away before it renders again
  // (a sent move's end sets the draft of the branch left, and the chat is on another branch). images changes the images alone (an upload was
  // answered, an image is no longer there): the text, the mentions and the quotes, with a comment being typed on one, stay as they are.
  // Several changes before a render each see the one before.
  const held = (): Held => ({ text: current.current, mentions: put.current?.picked ?? now.current.picked, references: put.current?.quotes ?? now.current.quotes,
    images: put.current?.images ?? now.current.images });
  useEffect(() => {
    registerComposer(chatId, branch, {
      get: held,
      set: (h) => {
        if (h.text !== current.current) { setBox(h.text); input.current?.focus(true); }
        put.current = { picked: [...h.mentions], quotes: [...h.references], images: [...h.images] };
        setPicked(put.current.picked);
        setQuotes(put.current.quotes);
        setImages(put.current.images);
      },
      images: (f) => {
        if (put.current) put.current = { ...put.current, images: f(put.current.images) };
        now.current = { ...now.current, images: f(now.current.images) };
        setImages(f);
      },
    });
    return () => { now.current.quotes = q.kept(); registerComposer(chatId, branch, null); };
  }, []);
  // While a move is pending nothing is saved on the server until the app goes away: a reload equals Back, so what Back would leave in the
  // composer is saved then. When only the composer goes away (another chat is opened), that is kept here as the branch's unsaved draft. A
  // comment typed in an open float goes with what is saved when the composer or the app goes away.
  useEffect(() => {
    put.current = null; // shown
    if (!getState().moves[chatId]) drafts.current!.change(text, picked, quotes, images);
  }, [text, picked, quotes, images]);
  useEffect(() => {
    const d = drafts.current!;
    const save = (h: Held) => d.change(h.text, h.mentions, h.references, h.images);
    const hide = () => {
      now.current.quotes = q.kept();
      const h = leftByBack(chatId, branch);
      if (h) save(h);
      else if (!getState().moves[chatId]) save(held());
      d.flush(true);
    };
    const off = onLeaving(hide);
    gone.current = false;
    return () => {
      gone.current = true;
      off();
      now.current.quotes = q.kept();
      if (!getState().moves[chatId]) save(held());
      d.flush();
      setImageError(chatId, branch, ""); // what the error line said of the images was for who saw it
    };
  }, []);

  const root = (children: ReactNode) => (
    <KeyboardLift><Sized {...tid("composer", { chat: chatId, branch })} onWidth={setWidth} style={styles.composer}>{children}</Sized></KeyboardLift>
  );
  // The @ list is a layer on the Esc order (ui/useEscLayer.ts): with the subagent drawer or another overlay open under it, one Esc closes the list
  // and keeps the draft, and the next one the overlay; the composer's own Esc (which stops the agent) does not see it.
  const matches = mention && c?.board ? mentionOptions(mention.q, boards, groups) : [];
  useEscLayer(!readOnly && matches.length > 0, () => setMention(null));
  if (!c) return null;
  if (c.archived) return root(<>
    {/* (shown as it was, it is not unarchived from here: the bar says why in the place of the button) */}
    <ArchivedBar off={readOnly} why={offWhy(where, left)} onUnarchive={() => api.unarchive("chats", c.id).catch((e) => setErr(e.message))} />
    {err && !readOnly ? <Text {...tid("composer-err")} size={12} tone="danger" style={styles.err}>{err}</Text> : null}
  </>);
  if (legacy) return root(<LegacyBar />);

  // esc: the agent is busy on the branch shown; a message that starts a new branch may go out all the same
  const { stop, blocked, esc } = composerControls(c, { newBranch: move, liveFork: !!c.agent && LIVE_FORK[c.agent] });
  const own = c.board ? boards[c.board] : undefined;
  const refs = c.board ? resolveMentions(plainText(text), boards, picked).filter((b) => b.id !== c.board) : [];
  const selected = canRef ? selectedOn(selection.count, board, onScreen, role) : 0;
  const off = sendOff(where); // its server is not connected: the chat is shown as it was, and nothing is sent, stopped or changed
  const frozen = off || left;
  // A wait that concerns this composer's Send (logic/waits.ts): it takes no press, says why, and shows a spinner while a message is on its way.
  const hold = sendWait(waits, branch);
  // Why the images hold the Send (logic/chatimage.ts imagesHold): an upload runs, the message is over what one takes (two drafts were joined),
  // or its model takes no images. The strip says the last two under the thumbnails, until images are removed or another model is chosen.
  const imagesHeld = imagesHold(images, up.uploads.length > 0, noImages);
  // Why no image can be added now, by a paste or by the attach button (logic/chatimage.ts imagesOff): the chat's server is not connected, or
  // the model takes none; nor to a chat its server no longer has. Nothing is uploaded then.
  const noAdd = left ? { line: goneText(where.name), title: goneText(where.name) } : imagesOff({ server: where.name, connected: where.connected, model: noImages });
  // The line under the composer (logic/sendend.ts underComposer): the last refusal's sentence with what the uploads say of the images, else
  // the move's, else the chat's own error.
  const under = underComposer([err, up.error].filter(Boolean).join(" "), c);

  // Files on their way into the message, by a paste or from the picker: one check for both (uploads.ts addImages).
  const add = (files: Parameters<typeof addImages>[2], skipped?: Parameters<typeof addImages>[3]["skipped"]) =>
    addImages(chatId, branch, files, { has: held().images, off: noAdd?.line, skipped });
  const attach = () => {
    const pick = parts.pickImages;
    if (!pick) return;
    void pick().then((r) => { if (r.files.length || r.skipped.length) add(r.files, r.skipped); }, (e) => setImageError(chatId, branch, `The files could not be picked: ${e?.message ?? e}`));
  };

  const submit = async () => {
    const t = text.trim();
    if ((!t && !quotes.length && !images.length) || blocked || off || left || sending || isSending(chatId)) return; // no send while busy, or while the composer of the branch left sends the move
    if (imagesHold(images, slotOf(chatId, branch).uploads.length > 0, noImages)) return; // nor while an image is on its way, or with images the message cannot carry
    if (sendWait(getState().waits[chatId], branch)) return; // nor while a fork's first message is on its way, or its agent starts on another model
    setSending(true); setErr(""); setImageError(chatId, branch, "");
    // The saver is told that this composer's Send runs, until it is answered: the removal of the sent draft is then not taken as another
    // window's. A sent move goes to another branch, and removes no draft of this one. The saver is told inside the try: whatever is thrown
    // after it, the Send is ended there (finally), and its mark does not stay.
    const p = picked, qs = quotes, im = images;
    let answered: ((refused?: boolean) => boolean) | null = null;
    let refused = false; // the server answered that it did not take the message: it removed no draft
    try {
      answered = getState().moves[chatId] ? null : drafts.current!.sending();
      input.current?.set(""); setMention(null); // the server clears the draft of the branch sent on; the empty one saved after it undoes a save still in flight
      setQuotes([]);
      setImages([]);
      await sendMessage(chatId, t, p, toSend(qs), im);
      // The sent message's mentions go; a draft that the sent move gave back keeps its own. The move's end set a copy of the list: the two are
      // compared by what they hold.
      setPicked((now) => (now.length === p.length && now.every((x, i) => x === p[i]) ? [] : now));
      // A sent move saves nothing here: the Send cleared the draft of the branch sent to, not this composer's, and the move's end (moveSent)
      // sets the drafts of both, this branch's through this composer while it is open.
    } catch (e: any) {
      refused = e instanceof ApiError && sentNothing(e.status, e.code); // (a 5xx may hide a message that was taken)
      const code = e instanceof ApiError ? e.code : undefined;
      // A chat of a section that its server no longer has (404 `not_found`): its view says so from here on, and the composer takes no more. The
      // `chat_removed` that tells the same may be on its way still.
      if (goneBySend(code) && getState().chats[chatId]) markGone(chatId);
      // (the server's state is read now: the Send that was refused for a server not connected has woken the connection, and the news can be here already)
      if (refusalShown(e instanceof ApiError ? e.status : undefined, code, serverConnected(getState(), where.server))) setErr(e?.message ?? String(e));
      // The Send is over for the saver, which tells whether the sent draft was removed on the server meanwhile: another window sent it, or this
      // Send was taken after all. The message is then not put back: it would be a draft of a sent message again, here, on the server and in the
      // other window. A Send refused because the chat no longer holds some of its images (409 `image_missing`, which names them): those do not
      // go back, and the error line says what must be added again.
      const lost = e instanceof ApiError && e.images?.length ? im.filter((x) => e.images!.includes(x.id)) : [];
      const back = withoutImages(im, lost.map((x) => x.id));
      const removed = answered?.(refused) ?? false;
      answered = null;
      if (putsBack(removed)) {
        setQuotes((now) => mergeQuotes(qs, now)); // with the quotes added while it was sent
        setImages((now) => withImages(back, now)); // and the images, before the ones added meanwhile
        if (!current.current.trim()) input.current?.set(t); // nothing typed is lost
        // A chat archived while it was sent draws no box: the composer holds the text again all the same, so its saver keeps it as the draft
        // (the emptied one is not saved, or the text is saved again), and the box shows it after an unarchive.
        if (!gone.current && !input.current && !current.current.trim()) setBox(t);
        // This composer went away while it was sent (another chat or branch was opened): the message is its branch's draft again unless a
        // pending move or a composer of the branch opened since holds it. Its saver writes the unsaved copy and saves it: a save of the emptied
        // draft still in flight then leaves that copy alone.
        if (gone.current && !sendFailed(chatId, branch, { text: t, mentions: p, references: qs, images: back }, e)) drafts.current!.change(t, p, qs, back);
        if (!gone.current) imagesGone(chatId, branch, lost);
      }
      // The chat is read again when its state here is stale (refreshAfterRefusal). Else the text is shown, and the message and a pending move
      // with its choice stay for a later Send.
      if (e instanceof ApiError && refreshAfterRefusal(e.status, e.code)) void refreshChat(chatId, e.code);
    } finally {
      answered?.(refused); setSending(false);
    }
  };
  submitNow.current = () => { void submit(); };
  const pick = (o: { board: { id: string; name: string } }) => {
    if (!mention) return;
    input.current?.replaceBeforeCaret(mention.q.length + 1, `@${o.board.name} `);
    setPicked((ps) => [...ps.filter((x) => x.name !== o.board.name), { name: o.board.name, id: o.board.id }]);
    setMention(null);
  };
  const onChange = (v: string, beforeCaret: string) => {
    setText(v); current.current = v;
    if (!c.board) return; // plain chats have no mentions
    const m = openMention(beforeCaret);
    setMention(m ? { ...m, i: 0 } : null);
  };
  const enters = enterSends(Platform.OS);
  const onKey = (e: KeyLike): boolean => {
    const act = boxAction(e, { mention: !!mention && matches.length > 0, enterSends: enters, stoppable: esc && !frozen });
    if (act === "next") setMention({ ...mention!, i: (mention!.i + 1) % matches.length });
    else if (act === "prev") setMention({ ...mention!, i: (mention!.i - 1 + matches.length) % matches.length });
    else if (act === "pick") pick(matches[mention!.i]);
    else if (act === "close") setMention(null);
    else if (act === "send") void submit();
    else if (act === "stop") void api.interrupt(chatId, shownBranch(getState(), chatId));
    return act !== null;
  };
  const stopNow = () => { api.interrupt(chatId, shownBranch(getState(), chatId)).catch((e) => setErr(e.message)); };

  const placeholder = offPlaceholder(where, usable, c, left) || (c.board ? "Ask or tell… (@ to mention a board)" : `Ask ${agentName(c.agent as AgentKind)}…`);
  const showStop = stop && !frozen;
  const tail = {
    attach: parts.AttachButton ? <parts.AttachButton off={noAdd?.title ?? ""} onPress={attach} /> : null,
    stop: showStop ? <StopButton title={esc ? "Stop (Esc)" : "Stop the subagents"} onPress={stopNow} /> : null,
    send: hold && !off && !left ? <SendButton title={hold.title} disabled spin={hold.spin} />
      : imagesHeld && !blocked && !off && !left ? <SendButton title={imagesHeld} disabled /> // the images hold it: an upload runs, or the message cannot carry them
      : <SendButton title={sendTitleFor(sendTitleOn(where, usable, c, blocked, left), enters)} disabled={blocked || off || left || sending || (!text.trim() && !quotes.length && !images.length)}
        onPress={() => void submit()} />,
  };
  const Banner = parts.BranchBanner;
  const boxHandlers = { onFocus: () => { hasFocus.current = true; setFocused(true); }, onBlur: () => { hasFocus.current = false; setFocused(false); } } as object;
  return root(<>
    {c.board ? (
      <ContextRow own={own} board={c.board} refs={refs} count={q.count} note={note} canRef={canRef} selected={selected} picking={picking} keys={names}
        onAddSelection={addSelectionNow} onPoint={() => startPick(chatId, onPhone())} />
    ) : (q.count || note) ? (
      <View {...tid("context-row")} style={styles.contextRow}>{q.count}<View style={styles.grow} />{note ? <Text {...tid("ctx-note")} size={11.5} tone="warn" style={styles.note}>{note}</Text> : null}</View>
    ) : null}
    {Banner ? <Banner chat={chatId} /> : null}
    <ModelNotice chatId={chatId} />
    <View {...tid("composer-box", { readonly: readOnly })} {...boxHandlers}
      style={[styles.box, { borderColor: focused && !readOnly ? t.accent : t.line2, backgroundColor: readOnly ? t.panel : t.bg }, focused && !readOnly && { boxShadow: `0 0 0 3px ${t.accentSoft}` }]}>
      {mention && !readOnly && matches.length > 0 ? <MentionList options={matches} at={mention.i} onPick={pick} /> : null}
      {parts.ImageStrip ? (
        <parts.ImageStrip chat={chatId} branch={branch} images={images} uploads={up.uploads} note={up.uploads.length ? "" : imagesHeld} again={where.connected}
          onRemove={readOnly ? undefined : (id) => setImages((now) => withoutImages(now, [id]))} />
      ) : null}
      <ChipInput ref={input} placeholder={placeholder} locked={readOnly} readOnly={readOnly} onChange={onChange} onKey={onKey}
        onImages={parts.ImageStrip ? (files) => add(files) : undefined} testID="composer-input" />
      <Toolbar chatId={chatId} onError={setErr} onInsert={() => input.current?.openInsert()} sending={sending} stop={showStop} tail={tail} insertKey={names.insert} />
    </View>
    {under ? <Text {...tid("composer-err")} size={12} tone="danger" style={styles.err}>{under}</Text> : null}
    {q.float}
  </>);
}

/** The uploads and the image error line of a branch's composer (uploads.ts Slot), as they change. */
function useUploads(chat: string, branch: string) {
  return useSyncExternalStore(subscribeUploads, () => slotOf(chat, branch));
}

const styles = StyleSheet.create({
  composer: { paddingTop: 6, paddingHorizontal: 12, paddingBottom: 12 },
  contextRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 6 },
  grow: { flexGrow: 1, flexBasis: 0 },
  note: { paddingVertical: 1, paddingHorizontal: 5 },
  box: { position: "relative", borderWidth: 1, borderRadius: 10, paddingTop: 8, paddingRight: 8, paddingBottom: 6, paddingLeft: 10 },
  err: { paddingTop: 5, paddingHorizontal: 2 },
});
