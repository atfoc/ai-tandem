import type { ExpoConfig } from "expo/config";

// Identity comes from the environment, never from the repository (AD-5, goal 4.9).
const iosBundleId = process.env.AIWB_IOS_BUNDLE_ID || "local.aiwhiteboard.app";
const androidPackage = process.env.AIWB_ANDROID_PACKAGE || "local.aiwhiteboard.app";
const iosTeamId = process.env.AIWB_IOS_TEAM_ID;

// The camera's usage text is the camera plugin's (it scans a server's code); the image picker would put its generic one in the same Info.plist key.
const CAMERA_TEXT = "AI Whiteboard uses the camera only to scan the code that your server shows, to add it. Nothing is recorded or kept.";

// The microphone is voice's (architecture VC-8): asked for at the first Dictate, Speech mode or orb, never before. No UIBackgroundModes: voice
// does not listen in the background (goal §5).
const MICROPHONE_TEXT = "AI Whiteboard listens only while you dictate or talk to a chat, and sends what it hears to ElevenLabs with your own key.";

const config: ExpoConfig = {
  name: "AI Whiteboard",
  slug: "ai-whiteboard",
  version: "1.0.0",
  orientation: "default",
  icon: "./assets/icon.png",
  ios: {
    supportsTablet: true,
    userInterfaceStyle: "automatic",
    bundleIdentifier: iosBundleId,
    // App Transport Security off, and nothing else in the dict (AD-36): a server reached by a dotted DNS name with a
    // pinned self-signed certificate fails under ATS, and NSAllowsLocalNetworking (Expo's default) makes ATS apply
    // again. "No plain HTTP" is kept by the app's code (aiwb-net's httpsURL), checked by test/noplainhttp.test.ts.
    infoPlist: {
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      // Why iOS asks, before the first connection to a server on the local network (AD-34, goal 4.7): the add-server flow says it too.
      NSLocalNetworkUsageDescription: "AI Whiteboard connects to the servers you add. A server on your home or office network is on your local network, so iOS asks you to allow it.",
      NSMicrophoneUsageDescription: MICROPHONE_TEXT,
    },
    ...(iosTeamId ? { appleTeamId: iosTeamId } : {}),
  },
  android: {
    package: androidPackage,
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
    // Voice's microphone (asked for at run time, at the first use) and its audio session: the communication mode and the speaker while
    // listening (architecture VC-8). The camera and the picker below still ask for no audio of their own.
    permissions: ["RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS"],
  },
  // Keeps the secure store's data out of Android's auto backup (whose restore could not decrypt it); `faceIDPermission:
  // false` leaves the Face ID usage text out of Info.plist: no secret asks for Face ID (AD-5).
  plugins: [
    ["expo-secure-store", { configureAndroidBackup: true, faceIDPermission: false }],
    // The camera scans the code of a server (scripts/server-code.sh) and records nothing (S12, goal 4.7): `recordAudioAndroid: false`.
    // Its `microphonePermission` is voice's text and not false: false deletes NSMicrophoneUsageDescription from Info.plist, and voice
    // needs it (architecture VC-8).
    ["expo-camera", { cameraPermission: CAMERA_TEXT, microphonePermission: MICROPHONE_TEXT, recordAudioAndroid: false }],
    // The picker of a message's images (K4, AD-26) opens the photo library only: the text iOS shows before it asks. `cameraPermission` is not
    // false: that would block the camera permission the scan needs on Android; the text is the camera plugin's. `microphonePermission` is
    // voice's text and not false: false blocks RECORD_AUDIO in the Android manifest (`tools:node="remove"`) and deletes the Info.plist text,
    // and voice's microphone needs both. The picker itself records nothing: it is opened on the photo library only.
    ["expo-image-picker", {
      photosPermission: "AI Whiteboard reads the pictures you choose to add to a message. It reads only those, and sends them to the server of that chat.",
      cameraPermission: CAMERA_TEXT,
      microphonePermission: MICROPHONE_TEXT,
    }],
  ],
  web: { output: "single", bundler: "metro", favicon: "./public/favicon.png" },
  // The window loads the export from file:// (AD-41): bundle, chunks, assets and fonts are named relative to the page.
  experiments: { baseUrl: "." },
};

export default config;
