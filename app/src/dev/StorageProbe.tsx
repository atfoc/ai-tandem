// A line on the screen of the app that says what the secure store and MMKV hold of the servers (package V4, `storage-picker-permission`): a
// device test reads it. Only a build made with EXPO_PUBLIC_AIWB_PROBE=1 has it (app/e2e/run.mjs, flows with `devhooks=1`), for a scratch server whose
// secret the build was told (EXPO_PUBLIC_AIWB_PROBE_SECRET); it never shows a secret, only whether the one it was told is where it should be.
//
//   probe: list=<entries in the saved list> secure=<of them with a secret in the secure store> match=<of them whose secret is the told one>
//          leak=<yes|no: the told secret is in the text of any MMKV instance the app has: the list, the app's own> gone=<entries seen in this launch that left
//          the list> gone-left=<of those, secrets still in the secure store> pending=<deletes the store still has to retry>
import { useEffect, useState } from "react";
import { Platform, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { digestStringAsync, CryptoDigestAlgorithm } from "expo-crypto";
import { createMMKV } from "react-native-mmkv";

import { LIST_KEY, PENDING_KEY, SECRET_PREFIX } from "../platform/serverstorecore.ts";
import { secretVault } from "../platform/serverstore.native.ts";

const SECRET_SHA256 = process.env.EXPO_PUBLIC_AIWB_PROBE_SECRET_SHA256 ?? "";
/** The MMKV instances the app opens (platform/serverstore.native.ts, platform/kv.native.ts). */
const INSTANCES = ["aiwb.servers", "aiwb.page"];

const seen = new Set<string>();

export async function probeText(): Promise<string> {
  const servers = createMMKV({ id: "aiwb.servers" });
  let ids: string[] = [];
  try {
    const list = JSON.parse(servers.getString(LIST_KEY) ?? "{}") as { servers?: { id?: unknown }[] };
    ids = (list.servers ?? []).flatMap((x) => (typeof x.id === "string" ? [x.id] : []));
  } catch { /* unreadable */ }
  ids.forEach((id) => seen.add(id));
  const held = (id: string) => secretVault.get(SECRET_PREFIX + id);
  const gone = [...seen].filter((id) => !ids.includes(id));
  const secrets = ids.flatMap((id) => { const v = held(id); return v ? [v] : []; });
  // the secrets of the secure store, looked for in the text of every MMKV instance the app has
  let leak = false;
  for (const id of INSTANCES) {
    const kv = createMMKV({ id });
    for (const key of kv.getAllKeys()) { const v = kv.getString(key) ?? ""; if (secrets.some((s) => v.includes(s))) leak = true; }
  }
  let matching = 0;
  for (const v of secrets) if (SECRET_SHA256 && (await digestStringAsync(CryptoDigestAlgorithm.SHA256, v)) === SECRET_SHA256) matching++;
  let pending = 0;
  try { pending = (JSON.parse(servers.getString(PENDING_KEY) ?? "[]") as unknown[]).length; } catch { /* none */ }
  return `probe: list=${ids.length} secure=${secrets.length} match=${matching} leak=${leak ? "yes" : "no"} gone=${gone.length} gone-left=${gone.filter((id) => !!held(id)).length} pending=${pending}`;
}

export function StorageProbe() {
  const [text, setText] = useState("probe: starting");
  useEffect(() => {
    let live = true;
    const tick = () => { probeText().then((t) => { if (live) setText(t); }, (e) => { if (live) setText(`probe: failed ${e}`); }); };
    tick();
    const t = setInterval(tick, 500);
    return () => { live = false; clearInterval(t); };
  }, []);
  // (Android's accessibility tree leaves out what stands under the status bar, which is where the line goes on iOS: there it goes just below it)
  const top = useSafeAreaInsets().top;
  return <Text testID="probe-storage" pointerEvents="none" style={[styles.line, Platform.OS === "android" && { top }]}>{text}</Text>;
}

const styles = StyleSheet.create({
  line: { position: "absolute", top: 1, left: 4, fontSize: 8, color: "#000", backgroundColor: "rgba(255,255,255,0.8)", zIndex: 99999, elevation: 99999 },
});
