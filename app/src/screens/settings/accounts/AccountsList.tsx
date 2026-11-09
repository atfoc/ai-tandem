// The list of Settings › Claude accounts (multiple-claude goal §1.1, screen 1; §1.7; plan D28): one ACCOUNTS section per connected server
// that has accounts ("ACCOUNTS · <server>" when there are several). In each: the computer's own Claude Code first (its login chip, the
// Default badge, its line; nothing to press), then each account in the order added (its name, its login chip, its container chips, its
// line, what waits for a restart; Edit, Log in, Stop container, Restart container; its login row while a login runs), then "+ Add account"
// and the hint. A press on an account's row opens its edit sheet. The phone's screen and the wide layouts' dialog both draw it; the rows
// follow the store's lists (the `aliases` event) with no reload, and each shown server is asked for its list again when it opens (D22).
// An account whose server's Docker cannot be used is greyed, and its Log in is off with the reason. Every word is core's.
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";

import type { Alias, AliasList } from "@aiwb/core/aliasesapi.ts";
import {
  ACTION_WORDS, ADD_ACCOUNT_HINT, HOST_ROW, accountLine, accountSections, containerChips, dockerUsable, loginChip, loginKey, pendingLine, rowActions,
  type AccountSection,
} from "@aiwb/core/logic/aliases.ts";
import { refreshAccounts } from "@aiwb/core/state/aliases.ts";

import { useStore } from "../../../state/useStore.ts";
import { Cell, CellGroup } from "../../../ui/Cells.tsx";
import { PHONE, TYPE } from "../../../ui/metrics.ts";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { webStyle } from "../../../ui/webstyle.ts";
import { restart, stop } from "./actions.ts";
import { ACCOUNTS_TID } from "./ids.ts";
import { LoginRow } from "./LoginRow.tsx";
import { logIn, openSheet } from "./open.ts";
import { ActionButton, Actions, Chip, Chips, Line, useSizes } from "./parts.tsx";

/** The badge of the host row: "Default", in the accent. */
function Badge({ text }: { text: string }) {
  const t = useTokens(), { phone } = useSizes();
  return (
    <View {...tid(ACCOUNTS_TID.chip, { chip: "default", tone: "accent" })} style={[styles.badge, { backgroundColor: t.accentSoft }]}>
      <Text size={phone ? TYPE.secondary : 11.5} tone="accent" weight="600">{text}</Text>
    </View>
  );
}

/** The computer's own Claude Code: never edited, logged in or out, or removed from here. */
function HostRow({ server, list }: { server: string; list: AliasList }) {
  const { name, phone } = useSizes();
  return (
    <View {...tid(ACCOUNTS_TID.host, { server })} style={[styles.row, phone && styles.rowPhone]}>
      <Text size={name} weight="600">{HOST_ROW.name}</Text>
      <Chips>
        <Chip chip={loginChip(list.host)} id="login" />
        <Badge text={HOST_ROW.badge} />
      </Chips>
      <Line testID={ACCOUNTS_TID.line}>{HOST_ROW.line}</Line>
    </View>
  );
}

type Busy = "restart" | "stop" | null;

/** An account's row: its words, its buttons, its login under way. */
function AccountRow({ server, a, list }: { server: string; a: Alias; list: AliasList }) {
  const t = useTokens(), { name, phone } = useSizes();
  const flow = useStore((s) => s.aliasLogins[loginKey(server, a.id)]);
  const [busy, setBusy] = useState<Busy>(null);
  const usable = dockerUsable(a, list.docker);
  const acts = rowActions(a, list.docker);
  const pending = pendingLine(a);
  const run = (what: Exclude<Busy, null>, f: () => Promise<void>) => { setBusy(what); void f().finally(() => setBusy(null)); };
  const spin = (what: Busy) => (busy === what ? <ActivityIndicator size="small" color={t.muted} /> : undefined);
  const edit = () => openSheet(server, a.id);
  const login = flow ? null : acts.login; // (while a login runs its row has the buttons)
  return (
    <View {...tid(ACCOUNTS_TID.row, { server, id: a.id, usable: usable ? "true" : "false", restart: a.restartNeeded ? "true" : "false" })} style={[styles.row, phone && styles.rowPhone]}>
      <Pressable onPress={edit} accessibilityRole="button" accessibilityLabel={`${a.name}, ${ACTION_WORDS.edit}`}
        style={({ pressed }: { pressed: boolean }) => [styles.press, phone && styles.pressPhone, pressed && { backgroundColor: t.hover2 }, webStyle({ cursor: "pointer" })]}>
        <Text size={name} weight="600" tone={usable ? "text" : "muted"}>{a.name}</Text>
        <Chips>
          <Chip chip={loginChip(a.login)} id="login" />
          {containerChips(a, list.docker).map(({ id, ...c }) => <Chip key={id} chip={c} id={id} />)}
        </Chips>
        <Line testID={ACCOUNTS_TID.line}>{accountLine(a, list.docker)}</Line>
        {pending ? <Line testID={ACCOUNTS_TID.pending} tone="warn">{pending}</Line> : null}
      </Pressable>
      <Actions>
        {acts.restart ? <ActionButton tone="primary" label={ACTION_WORDS.restart} testID={ACCOUNTS_TID.restart} icon={spin("restart")} disabled={!!busy || !usable}
          onPress={() => run("restart", () => restart(server, a))} /> : null}
        <ActionButton label={ACTION_WORDS.edit} testID={ACCOUNTS_TID.edit} onPress={edit} />
        {login ? <ActionButton label={ACTION_WORDS.login} testID={ACCOUNTS_TID.loginButton} disabled={!!acts.loginDisabled} title={acts.loginDisabled}
          onPress={() => logIn(server, a.id)} /> : null}
        {acts.stop ? <ActionButton label={ACTION_WORDS.stop} testID={ACCOUNTS_TID.stop} icon={spin("stop")} disabled={!!busy}
          onPress={() => run("stop", () => stop(server, a))} /> : null}
      </Actions>
      {flow ? <LoginRow server={server} id={a.id} flow={flow} /> : null}
    </View>
  );
}

/** One server's section. */
function Section({ s }: { s: AccountSection }) {
  const t = useTokens(), { phone } = useSizes();
  const rows = [<HostRow key="host" server={s.server} list={s.list} />, ...s.list.aliases.map((a) => <AccountRow key={a.id} server={s.server} a={a} list={s.list} />)];
  return (
    <View {...tid(ACCOUNTS_TID.section, { server: s.server })} style={styles.section}>
      <View style={phone ? styles.phoneInset : null}>
        <Text size={phone ? TYPE.secondary : 12} tone={phone ? "muted" : "accent"} weight={phone ? undefined : "600"} style={styles.caps} accessibilityRole="header">{s.title}</Text>
        <View style={[styles.card, { backgroundColor: t.bg, borderColor: t.line }]}>
          {rows.map((r, i) => (
            <View key={i}>
              {r}
              {i < rows.length - 1 ? <View pointerEvents="none" style={[styles.separator, phone && { marginLeft: PHONE.margin }, { backgroundColor: t.line }]} /> : null}
            </View>
          ))}
        </View>
      </View>
      {phone ? (
        <CellGroup footer={ADD_ACCOUNT_HINT}>
          <Cell label={ACTION_WORDS.add} tone="accent" chevron={false} testID={ACCOUNTS_TID.add} data={{ server: s.server }} onPress={() => openSheet(s.server)} />
        </CellGroup>
      ) : (
        <View style={styles.addWide}>
          <ActionButton label={ACTION_WORDS.add} testID={ACCOUNTS_TID.add} {...{ dataSet: { server: s.server } }} onPress={() => openSheet(s.server)} />
          <Line testID={ACCOUNTS_TID.addHint}>{ADD_ACCOUNT_HINT}</Line>
        </View>
      )}
    </View>
  );
}

export function AccountsList() {
  const servers = useStore((s) => s.servers), lists = useStore((s) => s.aliases);
  const sections = accountSections(servers, lists);
  const shown = sections.map((s) => s.server).join(" ");
  // Each shown server is asked for its list again (the login states the server learns afresh come by the `aliases` event).
  useEffect(() => {
    for (const id of shown.split(" ").filter(Boolean)) refreshAccounts(id).catch(() => { /* (the list kept is shown) */ });
  }, [shown]);
  return (
    <View {...tid(ACCOUNTS_TID.list)}>
      {sections.length ? sections.map((s) => <Section key={s.server} s={s} />) : <Line>No server with Claude accounts is connected.</Line>}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 12 },
  phoneInset: { marginHorizontal: PHONE.margin, marginBottom: 12 },
  caps: { textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: "hidden" },
  row: { paddingVertical: 10, paddingHorizontal: 12 },
  rowPhone: { paddingHorizontal: PHONE.margin },
  pressPhone: { marginHorizontal: -PHONE.margin, paddingHorizontal: PHONE.margin },
  press: { marginHorizontal: -12, marginTop: -10, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 2 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 12 },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 },
  addWide: { marginTop: 8, gap: 4 },
});
