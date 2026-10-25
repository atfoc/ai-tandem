// Home's route of the phone's stack and the group's (package H1 draws both: screens/home/Home.tsx and GroupScreen.tsx). The sidebar is the wide
// layouts' alone.
import { StyleSheet, View } from "react-native";

import { useTokens } from "../../../ui/theme.tsx";
import { Guard } from "../Guard.tsx";
import { GroupScreen } from "../../home/GroupScreen.tsx";
import { Home } from "../../home/Home.tsx";

export function HomeRoute() {
  const t = useTokens();
  return <View style={[styles.fill, { backgroundColor: t.bg }]}><Guard what="Home"><Home /></Guard></View>;
}

export function GroupRoute() {
  const t = useTokens();
  return <View style={[styles.fill, { backgroundColor: t.bg }]}><Guard what="the group"><GroupScreen /></Guard></View>;
}

const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 } });
