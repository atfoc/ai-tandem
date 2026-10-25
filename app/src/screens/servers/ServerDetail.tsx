// A server's detail on the phone (goal 3.8.2–3.8.4, mockups dl-03b, dl-03d, dl-05b): the one place for a server. Package S2.
import { useStore } from "../../state/useStore.ts";
import { Pressable, StyleSheet } from "react-native";

import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { tid } from "../../ui/tid.ts";
import { S2_TID } from "./ids.ts";
import { openServerEdit, type ServerParams } from "./open.ts";
import { ServerFacts } from "./ServerFacts.tsx";

export function ServerDetail({ params }: { params: ServerParams }) {
  return <ServerFacts id={params.id} place="screen" />;
}

/** The bar's "Edit": a text button in the accent. None for this computer's entry or an entry that is gone. */
export function ServerEditButton({ params }: { params: ServerParams }) {
  const editable = useStore((s) => { const v = s.servers.find((x) => x.id === params.id); return !!v && !v.local; });
  if (!editable) return null;
  return (
    <Pressable {...tid(S2_TID.edit)} accessibilityRole="button" accessibilityLabel="Edit" onPress={() => openServerEdit(params.id)} style={styles.edit}>
      <Text size={TYPE.control} tone="accent">Edit</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  edit: { minWidth: PHONE.target, minHeight: PHONE.target, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
});
