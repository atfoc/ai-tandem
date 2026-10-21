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
export const DICTATE_STOP_TITLE = "Stop dictating";
export const SPEECH_TITLE = "Speech mode";
export const SPEECH_END_TITLE = "End speech mode";

// ---- the speech bar and the mic mark (VC-17, VC-23)

export const SPEECH_BAR = "Speech mode";
export const SPEECH_MUTE = "Mute";
export const SPEECH_UNMUTE = "Unmute";
export const SPEECH_MUTE_TIP = "Stop sending your voice, and keep the session";
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
export const READ_STOP = "Stop reading";

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
export const PILL_ORB: Record<"idle" | "listening" | "countdown" | "waiting" | "thinking" | "speaking", string> = {
  idle: "Talk to a chat of this board",
  listening: "Stop listening",
  countdown: "Stop listening",
  waiting: "Stop listening",
  thinking: "Stop and put the voice away",
  speaking: SPEECH_WAVE_TIP,
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
export const ADVANCED_TTS_MULTILINGUAL = "Multilingual v2";
export const ADVANCED_STT_MODEL = "Transcription model";
export const ADVANCED_STT_SCRIBE = "Scribe, realtime";
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
export const ADVANCED_SPEED_VALUE = (speed: number): string => `${speed.toFixed(1)}×`;

/** The languages Settings offers: the two-letter codes (ISO 639-1) that both of the service's models take, with their names in English. */
export const LANGUAGES: readonly (readonly [code: string, name: string])[] = [
  ["ar", "Arabic"], ["bg", "Bulgarian"], ["cs", "Czech"], ["da", "Danish"], ["de", "German"], ["el", "Greek"], ["en", "English"],
  ["es", "Spanish"], ["fi", "Finnish"], ["fr", "French"], ["he", "Hebrew"], ["hi", "Hindi"], ["hr", "Croatian"], ["hu", "Hungarian"],
  ["id", "Indonesian"], ["it", "Italian"], ["ja", "Japanese"], ["ko", "Korean"], ["nl", "Dutch"], ["no", "Norwegian"], ["pl", "Polish"],
  ["pt", "Portuguese"], ["ro", "Romanian"], ["ru", "Russian"], ["sk", "Slovak"], ["sr", "Serbian"], ["sv", "Swedish"], ["tr", "Turkish"],
  ["uk", "Ukrainian"], ["vi", "Vietnamese"], ["zh", "Chinese"],
];
