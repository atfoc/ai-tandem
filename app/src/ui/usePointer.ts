// What the user points with (AD-70): hover actions show on hover with a mouse, and always (or on a long press) with
// touch. Native has touch only; usePointer.web.ts follows the last pointer event of the page.
export type Pointer = "mouse" | "touch";

export function usePointer(): Pointer {
  return "touch";
}
