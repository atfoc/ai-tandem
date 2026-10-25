# F2 — the phone's stack: the design the chunks build

The contract is PLAN.md §2 F2; this file fixes what it leaves open. Lead: F2 (Opus). Chunks: A (stack, place, back plan),
B (D4 layout), C (PhoneStack, routes, registry, presenter), D (NavBack, hold sheet), E (checks), F (device flow).

## 1. Entries (`screens/shell/stack.ts`, pure: no React, no react-native, Node loads it)

`StackEntry = { key, name, title, kind, route, id? }` (the stub's four fields plus two):

| route | key | name | title | kind | id |
|---|---|---|---|---|---|
| `home` | `home` | `home` | `Home` | place | — |
| `group` | `group:<group key>` | `group` | the group's name | place | group key |
| `board` | `board:<board key>` | `board` | the board's name | content | board key |
| `chat` | `chat:<chat key>` | `chat` | `chatTitle(chat)` (core `logic/labels.ts`) | content | chat key |
| `drawer` | `drawer:<chat key>` | `drawer` | `Subagent` | content | chat key |
| `pushed` | the pushed key `<name>#<n>` | the screen's name | its spec's `title(params)` / the overlay's `title` | spec's kind (overlays: place) | pushed key |

`stackOf(s, place = NO_PLACE, pushed: readonly StackEntry[] = [])`, bottom first:

1. `home`.
2. Groups. While a board or a chat is open (`shellView(s)` is not home): the groups of **its** place, `placeOf(s, view)` —
   server `serverOfKey(content key)`, groups the chain of keys of `board.group` (a board, or a chat on a board) or `chat.group`
   (a plain chat), outermost first, from that server's groups (`s.groups` for `LOCAL_SERVER`, `s.sections[server].groups`
   otherwise); empty when ungrouped or unknown. Otherwise (browsing): `place.groups`, cut at the first key the server's groups do
   not hold (`place.server ?? LOCAL_SERVER` names the server).
3. `board` (when the view is a board), `chat` (the view's chat), `drawer` (when `s.subDrawer.chat` is the chat on screen).
4. The pushed entries, in push order.

`HomePlace.server` is the server's entry id as `serverOfKey` gives it (`LOCAL_SERVER` = "local" for this computer's things);
`null` = not chosen yet (H1 picks the first). H1 maps its chips to these ids.

## 2. The back plan (pure, in stack.ts)

`planPopTo(s, entries, targetKey) → Plan | null`: what makes `targetKey` the top. `Plan = { popPushed: string | null` (the lowest
pushed key above the target: it and all above go) `, closeDrawer: boolean, sel: Sel | null` (the selection to set, null = unchanged)
`, place: HomePlace | null }` (the place to set, null = unchanged). Rules: a target of `board` while its chat is above →
`sel {board, chat: null}`; a target of `home` or a `group` while content is open → `sel {board: null, chat: null}` and
`place = { server: the content's server, groups: the content's group keys up to and including the target (none for home) }`;
a target of `home`/`group` while browsing → `place = { server: place.server, groups: up to the target }`; drawer above the target
→ `closeDrawer`. Unknown target or the top itself → null. `backTarget(entries)` = the key under the top, or null.

So "Back from content lands on the content's place, then Home", and the derived list after any back is a prefix of the one
before (the navigator pops; it never resets on a back).

## 3. The effects (`screens/shell/goback.ts`, app side)

`entriesNow()` = `stackOf(getState(), getHomePlace(), pushedEntries())`. `popTo(key)` applies the plan in this order: place, drawer,
`select`, then `popScreen(plan.popPushed)`. `goBack()`: `awayNow()` → `pickPoint(null)` (as today); else `popTo(backTarget)`.
`BackButton.tsx` re-exports `goBack`.

## 4. Home's place (`screens/shell/homeplace.ts`)

`getHomePlace()`, `useHomePlace()`, `setHomePlace(p)`, `setHomeServer(id)` (groups cleared; nothing when the same),
`pushGroup(key)`, `popToGroup(index)` (keeps `groups[0..index]`; −1 = Home), `subscribeHomePlace(l)`. Saved on every change with
`safeSet("aiwb.home", JSON.stringify(place))`; loaded once by `loadHomePlace()` from `bootstrap.ts` where `aiwb.sel` is read
(a malformed value is the default `{server: null, groups: []}`). The type `HomePlace` stays exported from `screens.ts` too.

## 5. The registry (`screens/shell/screens.ts`)

As the stub, plus: a pushed item may carry `onPop` (called when a back or `clearPushed` takes it away, not when its owner closes
it); `popScreen(key?, o?: { quiet?: boolean })` (quiet: no `onPop`); `pushedEntries()` (entries with titles and kinds from the
specs); `clearPushed()` (all, with their `onPop`); overlay items: `pushOverlay({ title, testID?, onPop }) → key` and
`setPushedContent(key, node)` / `usePushedContent(key)` (a store of the React node, as `ui/overlayhost.tsx` does: the content's
contexts are the app's providers). `select()` in nav.ts calls `clearPushed()` when the board or the chat changes: opening content
from a pushed screen (Archived › a chat) shows that content, not the screen over it.

## 6. The navigator (`PhoneStack.tsx`)

Routes `home`, `group`, `board`, `chat`, `drawer`, `pushed`; each route's params `{ entry: key }`; every route component is wrapped
in `EntryKeyContext` (`screens/shell/phone/entry.ts`) with its key. Store → navigator, comparing the lists of keys: the same →
nothing; one more on top → push; a prefix → pop(n); a new top not in the old list → reset to all but the top, then push it (the
content slides in); anything else → reset. Navigator → store (`onStateChange`): its keys a strict prefix of the derived ones →
`popTo(its top)` (`awayNow()` → `pickPoint(null)` first, as today). `gestureEnabled`: `board` never (D15); others `!picking`,
and a pushed spec's `edgeSwipe !== false`. Android's back is the navigator's own pop.

Route components (`screens/shell/phone/`): `HomeRoute.tsx` (`HomeRoute` = today's side screen, `side-pane`; `GroupRoute` a
stand-in until H1: `PlaceBar` with `NavBack`, the group's name, its subgroups (`group-row` dataSet `key`, a press `pushGroup`), its
boards and chats (`group-item` dataSet `kind`, `key`)), `BoardRoute.tsx` (today's board screen, `board-stage`), `ChatRoute.tsx`
(`chat-page`), `PushedRoute.tsx` (`PushedRoute`: `pushed-screen` dataSet `screen`, `entry`; a place spec or an overlay gets
`PlaceBar` with `NavBack` and the title, a spec's optional `right`; a content spec draws its own bar; and `DrawerRoute`,
`drawer-screen`, today's bar `phone-bar` with `NavBack`). The presenter (`ui/pushedscreen.tsx` `setScreenPresenter`) is installed
at import of `PhoneStack.tsx`: while `open`, it holds an overlay item (`pushOverlay` with `onPop: onClose`), updates its content
each render, and pops it quietly when `open` turns false or it unmounts; the overlay's `testID` is on the content's view.

## 7. NavBack and the hold sheet (`BackButton.tsx`, `StackSheet.tsx`)

`NavBack` = `BackControl` for the entry of its route (`useEntryKey()`; without one, the top). Nothing at the bottom entry. Label:
the title of the entry under it when its own kind is `place`; none on content. Press: `goBack()` when it is the top, else
`popTo(the entry under it)`. Hold: `haptic("select")` and the stack sheet: `PickerSheet` (`stack-sheet`), title "Go back to",
sub the entry's title, options the entries from the bottom up to and including its own (`picker-row` dataSet `value` = key),
value = its own key; a pick of another closes the sheet and `popTo`s it. `BackButton` stays exported (= `NavBack`).

## 8. The layout (D4)

`breakpoints.ts` `layoutOfWindow(width, height, native)`: native and the shorter side under `TABLET_FROM` → phone; else
`layoutOf(width)`. `useLayout()` uses it with `Platform.OS !== "web"`; `windowLayout()` (useLayout.ts) for code that reads
`Dimensions` (nav.ts `openBoard`, board/phone.ts, sidebar's rename guard, bootstrap). Web: unchanged.
