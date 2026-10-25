// A virtual list that keeps its end in view while the user has not left it (AD-75, goal 4.8; B-SM-06 to B-SM-10): the thread of a chat
// draws its rows with it, and so does the subagent drawer (S7). It opens at its end, follows the end as rows arrive and grow, and
// stays where the user put it once the user has scrolled up by more than 40 px (scroll.ts); scrolled back to the end it follows again.
//
// `follow: false` is a list that never follows (a subagent that has ended: it opens at its top and stays where it is put); `resetKey`
// draws the list anew, at its end or its top as `follow` says (another chat, another branch, another subagent).
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Platform, Pressable, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { LegendList, type LegendListRef, type LegendListRenderItemProps, type OnViewableItemsChangedInfo } from "@legendapp/list/react-native";

import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { T1_TID } from "./ids.ts";
import { follows, showLatest } from "./scroll.ts";

export type StickyListProps<T extends { key: string }> = {
  rows: readonly T[];
  renderRow: (row: T) => ReactElement | null;
  follow?: boolean;
  resetKey: string;
  /** The list's padding (the thread's: 14 beside a board, 20 on a page). */
  pad: number;
  /** The list's side padding where it is not `pad` (the phone's thread: 0 here, its rows carry the margin, since the web list places its rows
   *  over the padding). */
  padX?: number;
  /** Told the list's handle once it is drawn (null when it goes): what scrolls a row to the middle of the window from outside. */
  onList?: (list: ListHandle | null) => void;
  /** The phone's thread: a "↓ Latest" pill floats over the list's foot when the person scrolled up and the content then grew. */
  latest?: boolean;
  /** With `latest`: a value that is another one whenever what is at the thread's end changed (a row came, the last answer got longer). */
  tail?: unknown;
  /** Told the keys of the rows that are in view (at least 80% of each), whenever they change: the phone's permission dock reads it. */
  onViewable?: (keys: string[]) => void;
};

export type ListHandle = {
  /** Scrolls the row with this key to the middle of the window. false: the list has no such row. */
  scrollToKey(key: string, animated: boolean): boolean;
};

/** The list's own scroller carries the ids a check reads: the list draws its own element on web (a `div`, which takes `data-*` as they
 *  are) and a ScrollView on native (which takes `testID`). `follows`: the list follows its end now. */
function scrollIds(follows: boolean): Record<string, unknown> {
  return Platform.OS === "web" ? { "data-testid": "thread-scroll", "data-follows": String(follows) } : { testID: "thread-scroll" };
}

export function StickyList<T extends { key: string }>({ rows, renderRow, follow = true, resetKey, pad, padX, onList, latest = false, tail, onViewable }: StickyListProps<T>) {
  return <List key={resetKey} rows={rows} renderRow={renderRow} follow={follow} pad={pad} padX={padX ?? pad} onList={onList} latest={latest} tail={tail} onViewable={onViewable} />;
}

function List<T extends { key: string }>({ rows, renderRow, follow, pad, padX, onList, latest, tail, onViewable }: Omit<StickyListProps<T>, "resetKey" | "padX"> & { follow: boolean; padX: number }) {
  const [stick, setStick] = useState(follow);
  const [pill, setPill] = useState(false);
  const stuck = useRef(follow); // `stick`, for what runs outside a render
  const total = useRef(0); // the content's height as the list counts it
  const leftAt = useRef<number | null>(null); // the content's height when the person left the end
  const fresh = useRef(false); // the end of the thread changed since the person left it
  const tailWas = useRef(tail);
  const last = useRef(0);
  const list = useRef<LegendListRef>(null);
  const rowsNow = useRef(rows);
  rowsNow.current = rows;
  useEffect(() => {
    if (!onList) return;
    onList({
      scrollToKey(key, animated) {
        const index = rowsNow.current.findIndex((r) => r.key === key);
        if (index < 0 || !list.current) return false;
        void list.current.scrollToIndex({ index, animated, viewPosition: 0.5 });
        return true;
      },
    });
    return () => onList(null);
  }, [onList]);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const n = e.nativeEvent;
    const s = { offset: n.contentOffset.y, content: n.contentSize.height, view: n.layoutMeasurement.height };
    const before = last.current;
    last.current = s.offset;
    const next = follows(stuck.current, before, s);
    stuck.current = next;
    setStick(next);
    if (!latest) return;
    leftAt.current = next ? null : leftAt.current ?? total.current;
    if (next) fresh.current = false;
    setPill(showLatest(next, leftAt.current, total.current, fresh.current));
  }, [latest]);
  // the content grows (a row arrives, the last one gets longer) without a scroll event while the person reads above it
  useEffect(() => {
    const state = latest ? list.current?.getState() : undefined;
    if (!state) return;
    total.current = state.contentLength;
    return state.listen("totalSize", (size) => {
      total.current = size;
      setPill(showLatest(stuck.current, leftAt.current, size, fresh.current));
    });
  }, [latest]);
  useEffect(() => {
    if (tail === tailWas.current) return;
    tailWas.current = tail;
    if (!latest || stuck.current || leftAt.current === null) return;
    fresh.current = true;
    setPill(true);
  }, [latest, tail]);
  const toEnd = useCallback(() => {
    stuck.current = true;
    leftAt.current = null;
    fresh.current = false;
    setStick(true);
    setPill(false);
    void list.current?.scrollToEnd({ animated: true });
  }, []);
  const render = useCallback(({ item }: LegendListRenderItemProps<T>) => renderRow(item), [renderRow]);
  const viewableNow = useRef(onViewable);
  viewableNow.current = onViewable;
  const viewed = useCallback(({ viewableItems }: OnViewableItemsChangedInfo<T>) => viewableNow.current?.(viewableItems.map((v) => v.key)), []);
  const on = follow && stick;
  const legend = (
    <LegendList<T> ref={list}
      {...scrollIds(on)}
      data={rows as T[]} extraData={renderRow} keyExtractor={(r) => r.key} renderItem={render} estimatedItemSize={72}
      initialScrollAtEnd={follow} maintainScrollAtEnd={on} maintainVisibleContentPosition
      onScroll={onScroll} scrollEventThrottle={16}
      onViewableItemsChanged={onViewable ? viewed : undefined} viewabilityConfig={onViewable ? VIEWABILITY : undefined}
      {...(latest ? THREAD_KEYBOARD : undefined)}
      style={styles.fill} contentContainerStyle={{ paddingHorizontal: padX, paddingTop: pad - 6, paddingBottom: 6 }} />
  );
  if (!latest) return legend;
  return (
    <View style={styles.fill}>
      {legend}
      {pill && <LatestPill onPress={toEnd} />}
    </View>
  );
}

/** The phone's thread (`latest`): a drag down lowers the keyboard (interactive on iOS, as Messages does), and a tap on a button in it still works while it is up. */
export const THREAD_KEYBOARD = { keyboardDismissMode: Platform.OS === "ios" ? "interactive" : "on-drag", keyboardShouldPersistTaps: "handled" } as const;

/** The pill over the thread's lower right that goes to the end: 40 high, its target 44 (goal 3.5). */
function LatestPill({ onPress }: { onPress: () => void }) {
  const t = useTokens();
  return (
    <Pressable {...tid(T1_TID.latest)} role="button" accessibilityLabel="Jump to the latest message" onPress={onPress}
      hitSlop={(PHONE.target - PILL_HEIGHT) / 2}
      style={[styles.pill, { backgroundColor: t.bg, borderColor: t.line, boxShadow: t.shadowSm }]}>
      <Text size={TYPE.busy} weight="500">↓ Latest</Text>
    </Pressable>
  );
}

const PILL_HEIGHT = 40;
const VIEWABILITY = { itemVisiblePercentThreshold: 80 };

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  pill: {
    position: "absolute", right: PHONE.margin, bottom: 12, height: PILL_HEIGHT, minWidth: PHONE.target, paddingHorizontal: 16,
    borderWidth: 1, borderRadius: PILL_HEIGHT / 2, alignItems: "center", justifyContent: "center",
  },
});
