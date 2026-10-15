// The libraries in the order both popups show them (this computer's first, then the server list's), kept by the stream.
import { useMemo } from "react";

import { orderLibraries } from "@aiwb/core/logic/libraryview.ts";
import type { LibraryView } from "@aiwb/core/logic/library.ts";

import { useStore } from "../../state/useStore.ts";

export function useLibraries(): LibraryView[] {
  const libs = useStore((s) => s.libraries), servers = useStore((s) => s.servers);
  return useMemo(() => orderLibraries(libs, servers), [libs, servers]);
}
