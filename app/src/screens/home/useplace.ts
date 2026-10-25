// What Home and a group's screen read of the store for one server (package H1): the server's entry, whether the page holds its tree, and the
// input its lists are made from (model.ts `placeInput`), the same object while nothing it is made of changed. A chat that has no name of its own
// is named as the sidebar names it, by its first message; the titles are read as one string so a streaming reply does not make new lists.
import { useMemo } from "react";

import { chatTitle } from "@aiwb/core/logic/labels.ts";
import { serverConnected } from "@aiwb/core/logic/serverlists.ts";
import type { ServerView } from "@aiwb/core/logic/servers.ts";
import { threadOf, type State } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { placeInput, type PlaceInput } from "./model.ts";

const unnamedTitles = (s: State): string =>
  JSON.stringify(Object.values(s.chats).filter((c) => !c.name).map((c) => [c.id, chatTitle(c, threadOf(s, c.id)?.items)]));

export type PlaceData = { view: ServerView | undefined; held: boolean; input: PlaceInput | null };

export function usePlaceData(server: string | null): PlaceData {
  const servers = useStore((s) => s.servers), groups = useStore((s) => s.groups), sections = useStore((s) => s.sections);
  const boards = useStore((s) => s.boards), chats = useStore((s) => s.chats), gone = useStore((s) => s.gone), connected = useStore((s) => s.connected);
  const usable = useStore((s) => s.usable), catalogs = useStore((s) => s.catalogs), home = useStore((s) => s.home), defaultCwd = useStore((s) => s.defaultCwd);
  const lists = useStore((s) => s.lists);
  const titles = useStore(unnamedTitles);
  const view = server === null ? undefined : servers.find((v) => v.id === server);
  const held = server === null ? false : serverConnected({ sections, connected }, server);
  const input = useMemo((): PlaceInput | null => {
    if (server === null) return null;
    const names = new Map<string, string>(JSON.parse(titles) as [string, string][]);
    const base = placeInput({ groups, sections, boards, chats, gone, usable, catalogs, home, defaultCwd, lists }, server);
    return { ...base, titleOf: (c) => names.get(c.id) ?? chatTitle(c) };
  }, [server, groups, sections, boards, chats, gone, usable, catalogs, home, defaultCwd, lists, titles]);
  return { view, held, input };
}
