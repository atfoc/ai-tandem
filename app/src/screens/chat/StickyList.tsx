// A virtual list that keeps its end in view while the user has not left it (AD-75, goal 4.8; B-SM-06 to B-SM-10): the thread of a chat
// draws its rows with it, and so does the subagent drawer (S7). It opens at its end, follows the end as rows arrive and grow, and
// stays where the user put it once the user has scrolled up by more than 40 px (scroll.ts); scrolled back to the end it follows again.
//
// `follow: false` is a list that never follows (a subagent that has ended: it opens at its top and stays where it is put); `resetKey`
// draws the list anew, at its end or its top as `follow` says (another chat, another branch, another subagent).
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Platform, StyleSheet, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { LegendList, type LegendListRef, type LegendListRenderItemProps } from "@legendapp/list/react-native";

import { follows } from "./scroll.ts";

export type StickyListProps<T extends { key: string }> = {
  rows: readonly T[];
  renderRow: (row: T) => ReactElement | null;
  follow?: boolean;
  resetKey: string;
  /** The list's padding (the thread's: 14 beside a board, 20 on a page). */
  pad: number;
  /** Told the list's handle once it is drawn (null when it goes): what scrolls a row to the middle of the window from outside. */
  onList?: (list: ListHandle | null) => void;
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

export function StickyList<T extends { key: string }>({ rows, renderRow, follow = true, resetKey, pad, onList }: StickyListProps<T>) {
  return <List key={resetKey} rows={rows} renderRow={renderRow} follow={follow} pad={pad} onList={onList} />;
}

function List<T extends { key: string }>({ rows, renderRow, follow, pad, onList }: Omit<StickyListProps<T>, "resetKey"> & { follow: boolean }) {
  const [stick, setStick] = useState(follow);
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
    setStick((was) => follows(was, before, s));
  }, []);
  const render = useCallback(({ item }: LegendListRenderItemProps<T>) => renderRow(item), [renderRow]);
  const on = follow && stick;
  return (
    <LegendList<T> ref={list}
      {...scrollIds(on)}
      data={rows as T[]} extraData={renderRow} keyExtractor={(r) => r.key} renderItem={render} estimatedItemSize={72}
      initialScrollAtEnd={follow} maintainScrollAtEnd={on} maintainVisibleContentPosition
      onScroll={onScroll} scrollEventThrottle={16}
      style={styles.fill} contentContainerStyle={{ paddingHorizontal: pad, paddingTop: pad - 6, paddingBottom: 6 }} />
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 } });
