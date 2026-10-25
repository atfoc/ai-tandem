// "Ask about it" of the phone's image viewer: the image goes into the composer of the chat's shown branch, as an image the draft holds. It is on the
// chat's server already (a sent message holds it), so it is referenced, not uploaded again. Core's draft store takes it the way it takes an upload that
// was answered (state/uploads.ts `arrived`): the composer that is open holds it and saves it with its draft; with none open it goes into the branch's
// draft itself.
import { draftOf } from "@aiwb/core/logic/drafts.ts";
import { withImages } from "@aiwb/core/logic/chatimage.ts";
import { heldImages } from "@aiwb/core/state/actions.ts";
import { draftToShow, putDraft } from "@aiwb/core/state/chatdraft.ts";
import { getState, viewedBranch } from "@aiwb/core/state/store.ts";
import type { ChatImage } from "@aiwb/core/types.ts";

/** chat: the page's key of the top-level chat. An image the composer holds already is not added twice. */
export async function askAboutImage(chat: string, image: ChatImage): Promise<void> {
  if (!getState().chats[chat]) return;
  const branch = viewedBranch(getState(), chat), add = (now: ChatImage[]) => withImages(now, [image]);
  if (heldImages(chat, branch, add)) return;
  const d = draftToShow(chat, branch) ?? { text: "" };
  if (d.images?.some((x) => x.id === image.id)) return;
  await putDraft(chat, branch, draftOf(d.text, d.mentions, d.references, add([...(d.images ?? [])])));
}
