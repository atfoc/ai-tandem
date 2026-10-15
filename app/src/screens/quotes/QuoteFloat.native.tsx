// The comment field that floats at a passage exists on the web build's wide layouts only (QuoteFloat.web.tsx): native always takes the sheet
// (CommentSheet.tsx), and so does the phone layout of the web build. Never drawn here; the module exists so that the native bundle resolves it.
import type { Editing } from "./model.ts";

export type FloatProps = { chat: string; f: Editing; onText(t: string): void; onKeep(enter: boolean): void; onCancel(): void; onRemove?: () => void };

export function QuoteFloat(_: FloatProps) {
  return null;
}
