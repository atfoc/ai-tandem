// A fence around a part of the window: when what is inside it cannot be drawn (a record it does not expect), that part says so in
// one line and the rest of the window stays as it is (the old page's Guard.tsx).
import { Component, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "../../ui/Text.tsx";
import { tid } from "../../ui/tid.ts";

/** what: the part's name in the line ("the sidebar"). resetKey: when it changes (another sidebar row, the next version of the
 *  data) the content is drawn again. */
export class Guard extends Component<{ what: string; resetKey?: unknown; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e : new Error(String(e)) }; }
  componentDidCatch(e: unknown) { console.error(`${this.props.what} could not be shown:`, e); }
  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View {...tid("guard-fail", { what: this.props.what })} role="alert" style={styles.fail}>
        <Text tone="muted" size={12}>Couldn't show {this.props.what}.</Text>
        {error.message ? <Text tone="muted" size={12}>{error.message}</Text> : null}
      </View>
    );
  }
}

const styles = StyleSheet.create({
  fail: { flex: 1, minWidth: 0, paddingVertical: 12, paddingHorizontal: 14, gap: 4 },
});
