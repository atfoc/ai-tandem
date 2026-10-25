// What a press on a faded row says (Home's and a group screen's list of a server that is away): the server is offline, nothing opens.
import { showToast } from "../../ui/Toast.tsx";

export function offlineToast(name: string): void {
  showToast({ text: `${name} is offline. Its boards and chats come back when it does.` });
}
