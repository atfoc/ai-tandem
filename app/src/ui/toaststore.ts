// What the one toast is (Toast.tsx draws it): the toast shown, its timer, and the lifts that screens with a bottom bar ask for. No
// React and no react-native here, so Node loads it (test/toast.test.ts).

export type ToastSpec = {
  text: string;
  /** One action: Undo, Edit here, Show. */
  action?: { label: string; run(): void };
  /** How long it stays; 5000 by default. */
  ms?: number;
  /** A stable kind ("archived", "back-online"): the toast's dataSet `kind`. */
  kind?: string;
};

export type Shown = ToastSpec & { id: number };

export const TOAST_MS = 5000;

let shown: Shown | null = null;
let next = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** The listener is called after every change of the toast shown or of the lift; answers a function that removes it. */
export function subscribeToast(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getToast(): Shown | null { return shown; }

/** Shows a toast in place of the one shown (and restarts the time); answers a function that takes this one away, and only this one. */
export function showToast(spec: ToastSpec): () => void {
  const id = next++;
  clearTimeout(timer);
  shown = { ...spec, id };
  timer = setTimeout(() => hideToastById(id), spec.ms ?? TOAST_MS);
  emit();
  return () => hideToastById(id);
}

export function hideToast(): void {
  clearTimeout(timer);
  if (!shown) return;
  shown = null;
  emit();
}

function hideToastById(id: number): void {
  if (shown?.id === id) hideToast();
}

// The lifts: a screen with a bottom bar (the composer) asks for the toast to sit that many points higher. The one asked for last wins.
const lifts = new Map<object, number>();

/** Sets the lift `key` asks for, or takes it back with null. A key that asks again keeps its place in the order. */
export function setToastLift(key: object, px: number | null): void {
  if (px === null) { if (!lifts.delete(key)) return; }
  else if (lifts.get(key) === px) return;
  else lifts.set(key, px);
  emit();
}

/** Points the toast sits above its usual place: the last lift asked for, 0 when none. */
export function getToastLift(): number {
  let px = 0;
  for (const v of lifts.values()) px = v;
  return px;
}
