// The tree's shortcut as a title says it ("⌘⇧B" on the Apple platforms, "Ctrl+Shift+B" elsewhere). No React here.
import { treeKeyName } from "@aiwb/core/logic/treepopup.ts";

import { keyPlatform } from "../shell/keyplatform.ts";

export const treeKey = (): string => treeKeyName(keyPlatform());
