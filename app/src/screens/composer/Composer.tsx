// The message box under a chat, and its toolbar (the old page's Composer.tsx; AD-62). The pickers come from the server's catalogs and can be changed
// until the first message is sent: of a new chat, of a fork that has had none of its own, and of the branch a pending move starts.
// `Composer` is what the chat view draws (parts.tsx `Composer`): the composer of the branch the chat is on.
import { cloneElement, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref as ReactRef } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";

import { Sized } from "../../platform/sized";

import { api, ApiError } from "@aiwb/core/api.ts";
import { agentOpen, catalogFor, usableAgents } from "@aiwb/core/logic/agentlist.ts";
import { branchKey } from "@aiwb/core/logic/branches.ts";
import { boxOff, notConnectedLine, offPlaceholder, offWhy, sendOff, sendTitleOn } from "@aiwb/core/logic/chatserver.ts";
import { IMAGES_PER_MESSAGE, imagesHold, imagesOff, withImages, withoutImages } from "@aiwb/core/logic/chatimage.ts";
import { DraftSaver, boxText, hasDraft } from "@aiwb/core/logic/drafts.ts";
import { draftBacks } from "@aiwb/core/logic/draftsback.ts";
import { LIVE_FORK } from "@aiwb/core/logic/forkpoints.ts";
import { goneText } from "@aiwb/core/logic/remoteview.ts";
import type { Ref } from "@aiwb/core/logic/refs.ts";
import { selectedOn } from "@aiwb/core/logic/roles.ts";
import { goneBySend, putsBack, refusalShown, sentNothing, sentText, underComposer } from "@aiwb/core/logic/sendend.ts";
import { serverConnected } from "@aiwb/core/logic/serverlists.ts";
import { composerControls, notConnected, refreshAfterRefusal } from "@aiwb/core/logic/status.ts";
import { mergeQuotes, toSend } from "@aiwb/core/logic/quotes.ts";
import { sendWait } from "@aiwb/core/logic/waits.ts";
import { isSending, leftByBack, registerComposer, sendFailed } from "@aiwb/core/state/actions.ts";
import { refreshChat } from "@aiwb/core/state/conn.ts";
import { draftToShow, saveDraft } from "@aiwb/core/state/chatdraft.ts";
import { boardsOn, branchState, getState, isLegacy, markGone, shownBranch, shownView, unsavedDraft, viewedBranch } from "@aiwb/core/state/store.ts";
import { addImages, imagesGone, setImageError, slotOf, subscribe as subscribeUploads } from "@aiwb/core/state/uploads.ts";
import type { AgentKind, ChatImage, Held, Reference } from "@aiwb/core/types.ts";

import { ChipInput, type ChipInputHandle } from "../../platform/chipinput/ChipInput";
import type { KeyLike } from "../../platform/keys.types.ts";
import { onKey as onKeyPort } from "../../platform/keys";
import { onLeaving } from "../../platform/leaving";
import { KeyboardLift, useKeyboardUp } from "../../platform/keyboard";
import { useStore } from "../../state/useStore.ts";
import { agentName } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { PHONE } from "../../ui/metrics.ts";
import { usePhone } from "../../ui/useLayout.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { voice, useVoiceSession } from "../../voice/index.ts";
import { useWhere } from "../chat/hooks.ts";
import { openBoard } from "../shell/nav.ts";
import { EditKeys } from "./EditKeys.tsx";
import { PhoneComposer } from "./phone/PhoneComposer.tsx";
import { onPhone } from "../board/phone.ts";
import { RefBox, type RefBoxHandle } from "../board/RefBox.tsx";
import { RefChips } from "../board/RefChips.tsx";
import { addSelection, composerGone, registerInserter, startPick, startSelect, takeHeld } from "../board/refs.ts";
import { DictationBoxContext, type DictationBox } from "./dictation.ts";
import { registerBox } from "./focus.ts";
import { boxAction, keyNames, refKey, sendByKey, sendTitleFor } from "./keys.ts";
import { ArchivedBar, LegacyBar } from "./Blocked.tsx";
import { ContextRow, ModelNotice } from "./Notices.tsx";
import { composerParts, useComposerParts } from "./parts.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { keyPlatform } from "../shell/keyplatform.ts";
import { useEditingSettings } from "../../state/editing.ts";
import { dialogOpen, underDialog } from "./underdialog.ts";
import { SendButton, StopButton } from "./Send.tsx";
import { sendMessage } from "./send.ts";

/** The chat whose composer had the focus as it went away for the composer of another branch (the chat is on that one now): the one that
 *  opens takes the focus, as if it were the same. */
let refocus: string | null = null;

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
  const phone = usePhone(); // the phone draws its own composer (phone/PhoneComposer.tsx) from the same state; the wide layouts keep this one's tree
  const c = useStore((s) => shownView(s, chatId));
  const move = useStore((s) => !!s.moves[chatId]); // the next message starts a new branch
  const where = useWhere(c);
  const usable = useStore((s) => usableAgents(s, where.server)); // what a chat with no agent says depends on whether one can be chosen
  const boards = useStore((s) => boardsOn(s, where.server)); // the boards of its own server (its board is one)
  const left = useStore((s) => !!s.gone[chatId]); // its server no longer has the chat
  const selection = useStore((s) => s.selection);
  const onScreen = useStore((s) => s.sel.board);
  const role = useStore((s) => (c?.board ? s.roles[c.board] : undefined));
  const picking = useStore((s) => s.picking === chatId);
  // Tab, Shift+Tab and Enter in the box (Settings > Composer). Not on iOS and Android while a dialog or a popup is open: the box keeps its
  // focus under one there, and a hardware Tab would indent it unseen (the web box takes keys only while the page's focus is in it).
  const dialog = useStore(dialogOpen);
  const settings = useEditingSettings();
  const editing = Platform.OS !== "web" && dialog ? undefined : settings;
  const waits = useStore((s) => s.waits[chatId]); // what is on its way in the chat: a composer opened again reads the same
  // The model the message goes to, when it takes no images: the chat's, or the one chosen for a pending move's new branch. "": it takes them.
  const noImages = useStore((s) => {
    const v = shownView(s, chatId), id = s.moves[chatId]?.model ?? v?.model;
    const m = v ? catalogFor(s, where.server, v.agent)?.models.find((x) => x.id === id) : undefined;
    return m?.noImages ? m.label || m.id : "";
  });
  // Speech mode of this chat and branch (voice's speech bar, parts.SpeechBar): while it listens the bar stands in the place of the box and the
  // toolbar, which are hidden, not unmounted (the draft, the caret and the popovers hung from the toolbar stay). It ends with the composer: when
  // the chat leaves the screen, and not when another session took the microphone (then the composer re-rendered, and `owns` is false).
  const owns = useVoiceSession((s) => s.owner !== null && s.owner.kind === "speech" && s.owner.chat === chatId && s.owner.branch === branch);
  const speech = useVoiceSession((s) => s.owner !== null && s.owner.kind === "speech" && s.owner.chat === chatId && s.owner.branch === branch && s.phase !== "starting");
  const owning = useRef(owns);
  owning.current = owns;
  useEffect(() => () => { if (owning.current) voice.end(); }, []);
  const [text, setText] = useState(() => draftToShow(chatId, branch)?.text ?? "");
  const [quotes, setQuotes] = useState<Reference[]>(() => draftToShow(chatId, branch)?.references ?? []);
  const [images, setImages] = useState<ChatImage[]>(() => draftToShow(chatId, branch)?.images ?? []);
  const up = useUploads(chatId, branch); // the uploads that run for this branch, and what the error line says of the images
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const keyboardUp = useKeyboardUp(); // (the key row of Indent and Outdent stands over the soft keyboard: EditKeys.tsx)
  const input = useRef<ChipInputHandle>(null);
  const [boxRefs, setBoxRefs] = useState<Ref[]>([]); // the phone: the references the message holds (RefBox keeps them out of the box's text; the chips show them)
  const plusAt = useRef<{ start: number; end: number } | null>(null); // the phone: the box's caret when "+" opened its sheet
  const hasFocus = useRef(false);
  const current = useRef(text); // the text now, for a failed send
  const now = useRef({ quotes, images }); // with it, what the composer holds (for a move)
  now.current = { quotes, images };
  const put = useRef<{ quotes: Reference[]; images: ChatImage[] } | null>(null); // what a move set that no render has shown yet: the composer may go away before one does
  const drafts = useRef<DraftSaver | null>(null);
  const gone = useRef(false); // this composer went away
  // What voice's Dictate control takes of the box (dictation.ts): the text, a put that is dictation's own, and a watch for the person's typing. A change to
  // exactly the text dictation put last is not typing; any other change of the box's text is.
  const dictated = useRef<string | null>(null);
  const typedWatchers = useRef(new Set<() => void>());
  const dictation = useRef<DictationBox | null>(null);
  dictation.current ??= {
    text: () => current.current,
    put: (t) => { dictated.current = t; setBox(t); },
    watch: (typed) => { typedWatchers.current.add(typed); return () => { typedWatchers.current.delete(typed); }; },
    keeping: async (send) => {
      const answered = getState().moves[chatId] ? null : drafts.current!.keeping();
      let refused = false;
      try { return await send(); }
      catch (e) { refused = e instanceof ApiError && sentNothing(e.status, e.code); throw e; }
      finally { answered?.(refused); }
    },
  };
  // Puts a text into the composer. An archived chat draws no box, and the text is then set as what the composer holds all the same: left as
  // it was, it would go to the saver as typed with the next change of the quotes or the images, and two windows would save their texts over
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
      if (sendByKey(e, Platform.OS)) { // a hardware keyboard's ⌘Enter / Ctrl+Enter on the native boxes (keys.ts)
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
  // answered, an image is no longer there): the text and the quotes, with a comment being typed on one, stay as they are.
  // Several changes before a render each see the one before.
  const held = (): Held => ({ text: current.current, references: put.current?.quotes ?? now.current.quotes,
    images: put.current?.images ?? now.current.images });
  useEffect(() => {
    registerComposer(chatId, branch, {
      get: held,
      set: (h) => {
        if (h.text !== current.current) { setBox(h.text); input.current?.focus(true); }
        put.current = { quotes: [...h.references], images: [...h.images] };
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
    if (!getState().moves[chatId]) drafts.current!.change(text, quotes, images);
  }, [text, quotes, images]);
  useEffect(() => {
    const d = drafts.current!;
    const save = (h: Held) => d.change(h.text, h.references, h.images);
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
    <KeyboardLift gap={phone ? PHONE.keyboardGap : undefined} inside={styles.composer.paddingBottom}><Sized {...tid("composer", { chat: chatId, branch })} onWidth={setWidth} style={styles.composer}>
      <DictationBoxContext.Provider value={dictation.current}>{children}</DictationBoxContext.Provider>
    </Sized></KeyboardLift>
  );
  if (!c) return null;
  // (the phone draws an archived chat and one of the old board connection through its own composer: the block takes the box's place, Blocked.tsx)
  if (c.archived && !phone) return root(<>
    {parts.VoiceNotice ? <parts.VoiceNotice chatId={chatId} /> : null}
    {/* (shown as it was, it is not unarchived from here: the bar says why in the place of the button) */}
    <ArchivedBar off={readOnly} why={offWhy(where, left)} onUnarchive={() => api.unarchive("chats", c.id).catch((e) => setErr(e.message))} />
    {err && !readOnly ? <Text {...tid("composer-err")} size={12} tone="danger" style={styles.err}>{err}</Text> : null}
  </>);
  if (legacy && !phone) return root(<>{parts.VoiceNotice ? <parts.VoiceNotice chatId={chatId} /> : null}<LegacyBar /></>);

  // esc: the agent is busy on the branch shown; a message that starts a new branch may go out all the same
  const { stop, blocked, esc } = composerControls(c, { newBranch: move, liveFork: !!c.agent && LIVE_FORK[c.agent] });
  const own = c.board ? boards[c.board] : undefined;
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
  const attach = (pick = parts.pickImages) => {
    if (!pick) return;
    void pick().then((r) => { if (r.files.length || r.skipped.length) add(r.files, r.skipped); }, (e) => setImageError(chatId, branch, `The files could not be picked: ${e?.message ?? e}`));
  };

  const submit = async () => {
    const t = sentText(text); // (the first line's indent is kept: logic/sendend.ts)
    if ((!t && !quotes.length && !images.length) || blocked || off || left || sending || isSending(chatId)) return; // no send while busy, or while the composer of the branch left sends the move
    if (imagesHold(images, slotOf(chatId, branch).uploads.length > 0, noImages)) return; // nor while an image is on its way, or with images the message cannot carry
    if (sendWait(getState().waits[chatId], branch)) return; // nor while a fork's first message is on its way, or its agent starts on another model
    setSending(true); setErr(""); setImageError(chatId, branch, "");
    // The saver is told that this composer's Send runs, until it is answered: the removal of the sent draft is then not taken as another
    // window's. A sent move goes to another branch, and removes no draft of this one. The saver is told inside the try: whatever is thrown
    // after it, the Send is ended there (finally), and its mark does not stay.
    const qs = quotes, im = images;
    let answered: ((refused?: boolean) => boolean) | null = null;
    let refused = false; // the server answered that it did not take the message: it removed no draft
    try {
      answered = getState().moves[chatId] ? null : drafts.current!.sending();
      input.current?.set(""); // the server clears the draft of the branch sent on; the empty one saved after it undoes a save still in flight
      setQuotes([]);
      setImages([]);
      await sendMessage(chatId, t, toSend(qs), im);
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
        if (gone.current && !sendFailed(chatId, branch, { text: t, references: qs, images: back }, e)) drafts.current!.change(t, qs, back);
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
  const onChange = (v: string) => {
    if (v !== current.current && v !== dictated.current) for (const typed of [...typedWatchers.current]) typed(); // the person changed the box: dictation ends
    setText(v); current.current = v;
  };
  const onKey = (e: KeyLike): boolean => {
    const act = boxAction(e, { stoppable: esc && !frozen });
    if (act === "send") void submit();
    else if (act === "stop") void api.interrupt(chatId, shownBranch(getState(), chatId));
    return act !== null;
  };
  const stopNow = () => { api.interrupt(chatId, shownBranch(getState(), chatId)).catch((e) => setErr(e.message)); };

  const placeholder = offPlaceholder(where, usable, c, left) || (c.board ? "Ask or tell…" : `Ask ${agentName(c.agent as AgentKind)}…`);
  const showStop = stop && !frozen;
  const tail = {
    attach: parts.AttachButton ? <parts.AttachButton off={noAdd?.title ?? ""} onPress={() => attach()} /> : null,
    stop: showStop ? <StopButton title={esc ? "Stop (Esc)" : "Stop the subagents"} onPress={stopNow} /> : null,
    send: hold && !off && !left ? <SendButton title={hold.title} disabled spin={hold.spin} />
      : imagesHeld && !blocked && !off && !left ? <SendButton title={imagesHeld} disabled /> // the images hold it: an upload runs, or the message cannot carry them
      : <SendButton title={sendTitleFor(sendTitleOn(where, usable, c, blocked, left), names.send)} disabled={blocked || off || left || sending || (!text.trim() && !quotes.length && !images.length)}
        onPress={() => void submit()} />,
  };
  const Banner = parts.BranchBanner;
  const boxHandlers = { onFocus: () => { hasFocus.current = true; setFocused(true); }, onBlur: () => { hasFocus.current = false; setFocused(false); } } as object;
  const strip = parts.ImageStrip ? (
    <parts.ImageStrip chat={chatId} branch={branch} images={images} uploads={up.uploads} note={up.uploads.length ? "" : imagesHeld} again={where.connected}
      onRemove={readOnly ? undefined : (id) => setImages((now) => withoutImages(now, [id]))} />
  ) : null;
  // (the phone's box holds the plain text and the references stand as chips in the context row: screens/board/RefBox.tsx)
  const box = phone ? (
    <RefBox ref={input as ReactRef<RefBoxHandle>} placeholder={placeholder} locked={readOnly} readOnly={readOnly} onChange={onChange} onKey={onKey}
      onImages={parts.ImageStrip ? (files) => add(files) : undefined} testID="composer-input" size="phone" onRefs={setBoxRefs} editing={editing} />
  ) : (
    <ChipInput ref={input} placeholder={placeholder} locked={readOnly} readOnly={readOnly} onChange={onChange} onKey={onKey}
      onImages={parts.ImageStrip ? (files) => add(files) : undefined} testID="composer-input" size={undefined} editing={editing} />
  );

  // Indent and Outdent over the soft keyboard (iOS, Android: it has no Tab), right under the box, while the box edits like code and is
  // being typed in; not in speech mode (the box is hidden) nor on a block that takes the box's place (none is drawn then).
  const keyRow = Platform.OS !== "web" && editing && focused && keyboardUp && !readOnly && !speech
    ? <EditKeys onIndent={(outdent) => input.current?.indent?.(outdent)} /> : null;

  if (phone) {
    const why = left ? goneText(where.name) : frozen ? notConnectedLine(where.name) : "";
    const empty = !text.trim() && !quotes.length && !images.length && !up.uploads.length; // (an upload under way shows the soft Send, not Talk)
    const full = images.length + up.uploads.length >= IMAGES_PER_MESSAGE ? `A message takes ${IMAGES_PER_MESSAGE} images: remove one to add another` : "";
    return root(
      <PhoneComposer chatId={chatId} branch={branch} readOnly={readOnly} speech={speech} focused={focused} boxHandlers={boxHandlers}
        onPlusOpen={() => { plusAt.current = input.current?.caret() ?? null; }}
        context={c.board || q.count || note || boxRefs.length ? {
          board: c.board, own, count: q.count, note, onOpenBoard: () => { if (c.board) openBoard(c.board); },
          refChips: boxRefs.length ? <RefChips refs={boxRefs} readOnly={readOnly} onRemove={(i) => (input.current as RefBoxHandle | null)?.removeRef(i)} /> : undefined,
        } : null}
        chips={{ sending, onError: setErr }}
        lines={archived || legacy ? (parts.VoiceNotice ? <parts.VoiceNotice chatId={chatId} /> : null) : <>
          {Banner ? <Banner chat={chatId} /> : null}
          <ModelNotice chatId={chatId} plain />
          {parts.VoiceNotice ? <parts.VoiceNotice chatId={chatId} /> : null}
        </>}
        strip={strip} input={(blocked) => blocked ? cloneElement(box, { placeholder: "" }) : box} // (a box under a block has no placeholder: the block says why)
        block={{ where, gone: left, usable, refused: parts.ImageStrip ? underComposer(err, c) : under, onDismissRefused: () => setErr("") }}
        toolbar={{
          empty, voiceOff: why, plusOff: readOnly ? why : "",
          stop: showStop ? <StopButton size="touch" title={esc ? "Stop" : "Stop the subagents"} onPress={stopNow} /> : null,
          send: (why) => hold && !off && !left ? <SendButton size="touch" title={hold.title} disabled spin={hold.spin} />
            : imagesHeld && !blocked && !off && !left ? <SendButton size="touch" title={imagesHeld} disabled soft={up.uploads.length > 0} />
            : why ? <SendButton size="touch" title={why} disabled />
            : <SendButton size="touch" title={sendTitleFor(sendTitleOn(where, usable, c, blocked, left), "")} disabled={blocked || off || left || sending || empty}
              onPress={() => void submit()} />,
        }}
        plus={{
          board: c.board ? { id: c.board, name: own?.name ?? "board", archived: own?.archived } : undefined, selected,
          imagesOff: noAdd?.line ?? "", imagesFull: full, insertOff: readOnly ? why : "",
          onCamera: parts.takePhoto ? () => attach(parts.takePhoto!) : undefined,
          onLibrary: parts.pickImages ? () => attach() : undefined,
          onFiles: parts.pickFiles ? () => attach(parts.pickFiles!) : undefined,
          // (a row that puts something at the caret: the caret noted on "+", which the sheet's focus moved, is put back first)
          onInsert: () => input.current?.openInsert(plusAt.current),
          onAddSelection: () => { if (plusAt.current) input.current?.select(plusAt.current); startSelect(chatId); },
          onPoint: () => { if (plusAt.current) input.current?.select(plusAt.current); startPick(chatId, onPhone()); },
        }}
        keyRow={keyRow}
        speechBar={speech && parts.SpeechBar ? <parts.SpeechBar chatId={chatId} branch={branch} /> : null}
        float={q.float} />,
    );
  }
  return root(<>
    {c.board ? (
      <ContextRow own={own} board={c.board} count={q.count} note={note} canRef={canRef} selected={selected} picking={picking} keys={names}
        onAddSelection={addSelectionNow} onPoint={() => startPick(chatId, onPhone())} />
    ) : (q.count || note) ? (
      <View {...tid("context-row")} style={styles.contextRow}>{q.count}<View style={styles.grow} />{note ? <Text {...tid("ctx-note")} size={11.5} tone="warn" style={styles.note}>{note}</Text> : null}</View>
    ) : null}
    {Banner ? <Banner chat={chatId} /> : null}
    <ModelNotice chatId={chatId} />
    {parts.VoiceNotice ? <parts.VoiceNotice chatId={chatId} /> : null}
    {/* (the wrapper is always there, so that the box is the same element while speech mode comes and goes; hidden it keeps its width, which the toolbar's fit reads) */}
    <View {...tid("composer-away", { away: speech })} aria-hidden={speech} style={speech ? styles.away : undefined}>
    <View {...tid("composer-box", { readonly: readOnly })} {...boxHandlers}
      style={[styles.box, { borderColor: focused && !readOnly ? t.accent : t.line2, backgroundColor: readOnly ? t.panel : t.bg }, focused && !readOnly && { boxShadow: `0 0 0 3px ${t.accentSoft}` }]}>
      {strip}
      {box}
      <Toolbar chatId={chatId} branch={branch} onError={setErr} onInsert={() => input.current?.openInsert()} sending={sending} stop={showStop} tail={tail} insertKey={names.insert} />
    </View>
    {keyRow}
    </View>
    {speech && parts.SpeechBar ? <parts.SpeechBar chatId={chatId} branch={branch} /> : null}
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
  away: { height: 0, overflow: "hidden", opacity: 0, ...webStyle({ visibility: "hidden" }) },
  box: { position: "relative", borderWidth: 1, borderRadius: 10, paddingTop: 8, paddingRight: 8, paddingBottom: 6, paddingLeft: 10 },
  err: { paddingTop: 5, paddingHorizontal: 2 },
});
