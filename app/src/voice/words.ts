// Every sentence voice shows, in one place (goal §8: English only). Screens and the engine take their words from here; none writes a
// user-facing sentence of voice in its own file. The problem sentences and their actions are the table of architecture §12, the lines
// of Settings are the layout of §7.
import type { VoiceProblemKind } from "./ports.ts";

/** What a problem says and what its button does (`action` is the button's label; the screen knows the call each kind makes). */
export type ProblemWords = { sentence: string; action: string };

export const PROBLEM_WORDS: Record<VoiceProblemKind, ProblemWords> = {
  no_key: { sentence: "Voice needs your ElevenLabs key. It stays on this device.", action: "Open Settings" },
  key_rejected: { sentence: "ElevenLabs did not accept this key.", action: "Open Settings" },
  no_credits: { sentence: "Your ElevenLabs plan has no credits left.", action: "Open ElevenLabs" },
  mic_blocked: { sentence: "The app can't hear you. Turn on the microphone in system settings.", action: "Open system settings" },
  offline: { sentence: "Can't reach ElevenLabs.", action: "Try again" },
  service: { sentence: "ElevenLabs refused this. Open your account to see why.", action: "Open ElevenLabs" },
};

/** The problem popover's second button. */
export const PROBLEM_DISMISS = "Not now";

// ---- The composer (architecture §9): the titles of the two controls of its toolbar, and of their entries in the "more" popup

export const DICTATE_TITLE = "Dictate";
export const SPEECH_TITLE = "Speech mode";
export const SPEECH_END_TITLE = "End speech mode";

// ---- the speech bar and the mic mark (VC-17, VC-23)

export const SPEECH_BAR = "Speech mode";
export const SPEECH_MUTE = "Mute";
export const SPEECH_UNMUTE = "Unmute";
export const SPEECH_MUTE_TIP = "Send no voice, and keep the session";
export const SPEECH_UNMUTE_TIP = "Send your voice again";
export const SPEECH_END = "End";
export const SPEECH_END_TIP = "End speech mode";
export const SPEECH_LISTENING = "Listening…";
export const SPEECH_MUTED = "Muted. Unmute to talk.";
export const SPEECH_SENDING = "Sending…";
export const SPEECH_THINKING = "Waiting for the reply…";
export const SPEECH_WAVE_TIP = "Tap to interrupt";
export const MIC_MARK = "Spoken";

// ---- Read aloud (architecture VC-24)

export const READ_ALOUD = "Read aloud";
export const READ_END = "End reading";
export const READ_CONTINUE = "Continue reading";

// ---- the board's pill (VC-28)

export const PILL_NEW_CHAT = "+ New chat";
export const PILL_NO_CHAT = "No chat yet";
export const PILL_CHIP = (name: string): string => `Talking to ${name}. Choose another chat.`;
export const PILL_CHATS = "Chats of this board";
export const PILL_NO_CHATS = "This board has no chats yet.";
export const PILL_SHOW_ALL = (n: number): string => `Show all (${n})`;
export const PILL_SHOW_FEWER = "Show fewer";
export const PILL_ARCHIVED = "Archived";
export const PILL_TO = (name: string): string => `Sending to ${name}`;
export const PILL_TO_NONE = "Sending to a new chat";
export const PILL_LISTENING = "Listening…";
export const PILL_STARTING = "Starting the microphone…";
export const PILL_AUTOSEND = "Auto-send";
export const PILL_CANCEL = "Cancel";
export const PILL_SEND = "Send";
export const PILL_SEND_BADGE = "Send what you said";
export const PILL_COUNTDOWN = (seconds: number): string => `${seconds.toFixed(1)} s`;
export const PILL_COLLAPSE = "Collapse to the orb";
export const PILL_EXPAND = "Show the voice bar";
/** The selection chip over the pill: what goes with the turn, and the × that leaves it out. */
export const PILL_SELECTED = (n: number): string => `${n} selected`;
export const PILL_SELECTION_TIP = (n: number): string => `${n} selected on the board go with what you say`;
export const PILL_SELECTION_REMOVE = "Do not send the selection";
/** The captions over the pill (screen readers): what the person said, and the reply being spoken. */
export const PILL_SAID = "You said";
export const PILL_SPOKEN = "Reply";
/** What the orb does when it is pressed, by its state (its tooltip and its label). */
export const PILL_ORB: Record<"idle" | "listening" | "countdown" | "waiting" | "thinking" | "speaking" | "paused", string> = {
  idle: "Talk to a chat of this board",
  listening: "End",
  countdown: "End",
  waiting: "End",
  thinking: "End",
  speaking: SPEECH_WAVE_TIP,
  paused: "Continue",
};

// ---- Settings > Voice (architecture §7)

export const SETTINGS_BUTTON = "Settings";
export const SETTINGS_VOICE_TITLE = "Voice";

export const KEY_TITLE = "ElevenLabs API key";
export const KEY_PLACEHOLDER_SAVED = "A key is saved on this device";
export const KEY_STORED_NOTE = "Stored on this device only. Sent only to elevenlabs.io.";
export const KEY_SHOW = "Show";
export const KEY_HIDE = "Hide";
export const KEY_TEST = "Test key";
export const KEY_SAVE = "Save";
/** The result line of Test key when it works. */
export const keyWorks = (voices: number): string => `Works: ${voices} ${voices === 1 ? "voice" : "voices"} found.`;
export const KEY_REMOVE = "Remove key from this device";

export const VOICES_TITLE = "Voice";
export const VOICES_NO_KEY = "Add your key to choose a voice.";
export const VOICES_SHOW_ALL = "Show all voices";

export const AUTOSEND_TITLE = "Speech mode sends my turn";
export const AUTOSEND_ON = "Auto-send";
export const AUTOSEND_OFF = "Tap to send";

export const ADVANCED_TITLE = "Advanced options";
export const ADVANCED_TTS_MODEL = "Speech model";
export const ADVANCED_TTS_FLASH = "Flash v2.5";
export const ADVANCED_TTS_V4_TURBO = "v4 Turbo";
export const ADVANCED_TTS_MULTILINGUAL = "Multilingual v2";
export const ADVANCED_STT_MODEL = "Transcription model";
export const ADVANCED_STT_SCRIBE = "Scribe v2 Realtime";
export const ADVANCED_LANGUAGE = "Language";
export const ADVANCED_LANGUAGE_AUTO = "Auto-detect";
export const ADVANCED_PAUSE = "Pause before auto-send";
export const ADVANCED_SPEED = "Playback speed";
export const ADVANCED_SKIP_CODE = "Skip code blocks when reading";

// ---- Settings > Voice: the lines P12 added around the sections of §7

export const SETTINGS_TITLE = "Settings";
export const SETTINGS_CLOSE = "Close";
export const KEY_PLACEHOLDER = "sk_…";
export const KEY_BAD = "That is not a key. A key has no spaces and no other letters than the plain ones.";
export const KEY_SAVED = "Key saved on this device.";
export const KEY_TESTING = "Testing…";
export const KEY_REMOVE_TITLE = "Remove the key from this device?";
export const KEY_REMOVE_BODY = "Voice stops working until you add a key again. Your ElevenLabs account is not touched.";
export const KEY_REMOVE_DO = "Remove key";
export const KEY_REMOVED = "Key removed from this device.";

export const VOICES_LOADING = "Loading voices…";
export const VOICES_FAILED = "The voices could not be loaded.";
export const VOICES_RETRY = "Try again";
export const VOICES_SHOW_FEWER = "Show fewer voices";
export const VOICES_MORE = "More voices";
export const VOICES_SEARCH = "Search voices";
export const VOICES_NONE = "No voice found.";
export const VOICES_PLAY = (name: string): string => `Play ${name}`;
export const VOICES_COUNT = (shown: number, total: number): string => `${shown} of ${total} voices`;

export const AUTOSEND_NOTE = "What a spoken turn does after you stop talking. The speech bar and the board's pill change the same setting.";

export const ADVANCED_PAUSE_VALUE = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
export const ADVANCED_SPEED_VALUE = (speed: number): string => `${Number(speed.toFixed(2))}×`;

/** The languages Settings offers: the two-letter codes (ISO 639-1) that both of the service's models take, with their names in English. */
export const LANGUAGES: readonly (readonly [code: string, name: string])[] = [
  ["ar", "Arabic"], ["bg", "Bulgarian"], ["cs", "Czech"], ["da", "Danish"], ["de", "German"], ["el", "Greek"], ["en", "English"],
  ["es", "Spanish"], ["fi", "Finnish"], ["fr", "French"], ["he", "Hebrew"], ["hi", "Hindi"], ["hr", "Croatian"], ["hu", "Hungarian"],
  ["id", "Indonesian"], ["it", "Italian"], ["ja", "Japanese"], ["ko", "Korean"], ["nl", "Dutch"], ["no", "Norwegian"], ["pl", "Polish"],
  ["pt", "Portuguese"], ["ro", "Romanian"], ["ru", "Russian"], ["sk", "Slovak"], ["sr", "Serbian"], ["sv", "Swedish"], ["tr", "Turkish"],
  ["uk", "Ukrainian"], ["vi", "Vietnamese"], ["zh", "Chinese"],
];

// ---- Voice devices (voice-devices architecture VD-5, VD-7, VD-12, VD-13, VD-16, VD-17; wording to confirm, status.md)

/** The pause (VD-12): the button that goes on, in the speech bar and the pill. Read aloud's is READ_CONTINUE, the orb's is PILL_ORB.paused. */
export const VOICE_CONTINUE = "Continue";

/** The card of Settings > Voice (VD-17) and its two rows. */
export const DEVICES_TITLE = "Microphone and speaker";
/** Where the devices card stands before a key is saved (voice-devices goal 6.6: nothing is listed until voice is set up). */
export const DEVICES_NO_KEY = "Add your key to choose a microphone and a speaker.";
export const DEVICES_MIC = "Microphone";
export const DEVICES_SPEAKER = "Speaker";
/** The first option of both pickers, and with the device the system uses now. */
export const DEVICE_SYSTEM = "System default";
export const DEVICE_SYSTEM_NAMED = (name: string): string => `System default (${name})`;
/** A saved device that is not listed now: still shown, still selected (goal 6.3). */
export const DEVICE_MISSING = (name: string): string => `${name} (not connected)`;
/** What a saved device without a name is called in the picker. */
export const DEVICE_UNNAMED = "Saved device";
/** Where the platform decides, instead of a picker (VD-17). */
export const SPEAKER_FOLLOWS = "Follows the system: headphones or a headset when connected, otherwise the speaker.";
export const MIC_FOLLOWS = "Follows the system: the microphone the system uses.";
/** Neither can be chosen: the card holds this line and no control. */
export const DEVICES_NEITHER = "Voice uses the system's microphone and speaker. Change them in the system's settings.";
/** The notes under the card's title: Android 12+, and the web build before the microphone is allowed (VD-7). */
export const DEVICES_LINKED_NOTE = "A headset is used for both listening and speaking while you talk to a chat.";
export const DEVICES_HIDDEN_NOTE = "Allow the microphone to see your other devices.";

/** The checks (VD-15, VD-16). */
export const MIC_TEST = "Test microphone";
export const MIC_TEST_END = "End test";
export const MIC_TEST_BUSY = "Voice is listening.";
export const SPEAKER_TEST = "Test speaker";

/** The names the Android module gives its built-in devices, which the system names after the phone's model (VD-5). */
export const BUILTIN_MIC_NAME = "Phone microphone";
export const BUILTIN_SPEAKER_NAME = "Phone speaker";

/** The notices (VD-13). A name arrives already cut and is put in curly quotes here. A start says "isn't connected", a loss "was disconnected".
 *  A variant without a name is for a device whose name is not known. `logic/devices.ts` `noticeText` chooses among them. */
const q = (name: string): string => `“${name}”`;
export const NOTICE_START_MIC = (mic: string): string => `${q(mic)} isn't connected. Using the system microphone.`;
export const NOTICE_START_MIC_UNNAMED = "The microphone isn't connected. Using the system microphone.";
export const NOTICE_START_SPEAKER = (speaker: string): string => `${q(speaker)} isn't connected. Using the system speaker.`;
export const NOTICE_START_SPEAKER_UNNAMED = "The speaker isn't connected. Using the system speaker.";
export const NOTICE_START_BOTH = (mic: string, speaker: string): string => `${q(mic)} and ${q(speaker)} aren't connected. Using the system's own.`;
export const NOTICE_START_BOTH_UNNAMED = "The microphone and the speaker aren't connected. Using the system's own.";
export const NOTICE_LOST_MIC = (name: string): string => `${q(name)} was disconnected. Listening with the system microphone.`;
export const NOTICE_LOST_MIC_UNNAMED = "The microphone was disconnected. Listening with the system microphone.";
export const NOTICE_LOST_SPEAKER = (name: string): string => `${q(name)} was disconnected. Speaking through the system speaker.`;
export const NOTICE_LOST_SPEAKER_UNNAMED = "The speaker was disconnected. Speaking through the system speaker.";
export const NOTICE_PAUSED = (name: string): string => `${q(name)} was disconnected. Paused so nothing is played out loud.`;
export const NOTICE_PAUSED_UNNAMED = "Your headphones were disconnected. Paused so nothing is played out loud.";

// ux-s3: Settings › Voice on the phone

/** The no-key card (07b) and what waits for a key. */
export const VS_PROMO_TITLE = "Talk to your agents";
export const VS_PROMO_BODY = "Talk to your agents and hear replies. Voice uses your own ElevenLabs account.";
export const VS_ADD_KEY = "Add ElevenLabs key";
export const VS_GET_KEY = "No key yet? Get one at elevenlabs.io ↗";
export const VS_GET_KEY_URL = "https://elevenlabs.io/app/settings/api-keys";
export const VS_NO_KEY_FOOTER = "Speech mode and the advanced options appear once a key is saved.";

/** The key row, the voice and the groups of the screen (07). */
export const VS_KEY_SAVED = "Saved on this device ✓";
export const VS_FIRST_VOICE = "Your account's first voice";
export const VS_PLAYING = "Playing sample…";
export const VS_CHOOSE_VOICE = "Choose voice";
export const VS_SENDING_TITLE = "Sending";
export const VS_AUTOSEND = "Auto-send after speaking";
export const VS_AUTOSEND_FOOTER = "Sends your turn after a pause. For board chats and regular chats alike. Off: you tap Send.";
export const VS_ADVANCED_TITLE = "Advanced";
export const VS_STT_MODEL = "Transcription";
export const VS_SKIP_CODE = "Skip code blocks";
export const VS_REMOVE_KEY = "Remove key from this device";

/** Add key (P3). */
export const VS_KEY_SHEET_TITLE = "ElevenLabs key";
export const VS_KEY_FIELD = "API key";
export const VS_KEY_PASTE = "Paste";
export const VS_KEY_SHOW = "Show key";
export const VS_KEY_HIDE = "Hide key";
export const VS_KEY_WORKS = (voices: number): string => `✓ ${keyWorks(voices)}`;
export const VS_KEY_PROBLEM = (sentence: string): string => `! ${sentence}`;

/** Choose voice (P5). */
export const CV_TITLE = "Choose voice";
export const CV_CHOSEN = "Chosen";
export const CV_STOP_SAMPLE = "Pause sample";

/** The device rows of Advanced (chunk 4). */
export const VS_DEVICE_SYSTEM_VALUE = "System";
export const VS_DEVICE_SHEET_SUB = "Used for voice on this device";

// ux-v1: the phone's composer voice (goal 3.7.2, 3.7.3): Talk, Dictate, Send, Cancel, Interrupt, Mute, End; Listening, Sending in N s, Thinking…, Speaking, Muted
export const TALK_TITLE = "Talk";
export const TALK_END_TITLE = "End";
export const DICTATE_END_TITLE = "End dictation";
export const DICTATE_LINE_LISTENING = "Listening…";
export const DICTATE_LINE_END = "Tap the mic to end";
export const BAR_LISTENING = "Listening";
export const BAR_SENDING = (seconds: number): string => `Sending in ${seconds} s`;
export const BAR_THINKING = "Thinking…";
export const BAR_SPEAKING = "Speaking";
export const BAR_MUTED = "Muted";
export const BAR_PAUSED = "Paused";
export const BAR_INTERRUPT = "Interrupt";

// ux-v1: the board's orb and card

/** The docked orb's accessibility label for each state: the vocabulary, Talk, End, Interrupt, Continue. */
export const BOARD_ORB: Record<"idle" | "listening" | "countdown" | "waiting" | "thinking" | "speaking" | "paused", string> = {
  idle: "Talk",
  listening: "End",
  countdown: "End",
  waiting: "End",
  thinking: "End",
  speaking: "Interrupt",
  paused: "Continue",
};
export const BOARD_ORB_BADGE = (n: number): string => `${n} selected shape${n === 1 ? "" : "s"} go with what you say`;

/** The voice card of a phone board. */
export const CARD_TO = "To:";
export const CARD_TO_LABEL = (name: string): string => `Send to ${name}. Choose another chat.`;
export const CARD_NEW_CHAT = "New chat";
export const CARD_SENDING_IN = (seconds: number): string => `Sending in ${seconds} s`;
export const CARD_THINKING = (agent: string): string => `${agent} · thinking…`;
export const CARD_SPEAKING = (agent: string): string => `${agent} · speaking`;
export const CARD_IN = (chat: string): string => `In “${chat}”`;
export const CARD_OPEN_CHAT = "Open chat";
export const CARD_INTERRUPT = "Interrupt";
export const CARD_AGENT_NONE = "Your agent";
export const CARD_WITH_SELECTED = (n: number): string => `With ${n} selected shape${n === 1 ? "" : "s"}`;

// ux-v1: Set up voice (the phone's sheet for every voice problem)
export const SETUP_TITLE = "Set up voice";
export const SETUP_TALK = (agent: string): string => `Talk to ${agent}, or dictate into the box, with your voice.`;
export const SETUP_NOTE = "Voice runs on ElevenLabs, a speech service with its own account. Add your ElevenLabs API key once; it stays on this device and is sent only to elevenlabs.io.";
export const SETUP_OPEN_VOICE = "Open Settings › Voice";
export const SETUP_ELEVENLABS_TITLE = "ElevenLabs";
export const SETUP_MIC_TITLE = "Microphone";
export const SETUP_OFFLINE_TITLE = "Can't reach ElevenLabs";
export const SETUP_YOUR_AGENTS = "your agents";
