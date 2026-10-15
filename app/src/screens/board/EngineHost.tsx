// The hidden engine view (engine.ts, AD-52), drawn at the root of the app while one is wanted: it is in the `Overlays` slot of
// the shell, which is always mounted.
import { useSyncExternalStore } from "react";

import { BoardHost } from "../../platform/board";
import { engine } from "./engine.ts";

export function EngineHost() {
  const { on, gen } = useSyncExternalStore(engine.subscribe, engine.state);
  return on ? <BoardHost key={gen} hidden testID="board-engine" onChannel={engine.hostChannel} /> : null;
}
