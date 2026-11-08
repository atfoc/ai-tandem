// Placeholder: interactions of our own on the editor (a later child of the window lane fills it). Called once by Board at mount;
// returns what undoes it.
import type { Editor } from "tldraw";

export function installInteractions(_editor: Editor): () => void {
  return () => {};
}
