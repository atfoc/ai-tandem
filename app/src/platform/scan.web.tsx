// The scan port on web: there is no camera scan in the browser build (the paste path is the one it has), so no scan button is drawn.
import type { ScannerProps } from "./scan.types.ts";

export type { ScannerProps } from "./scan.types.ts";

export const canScan = false;

export function CodeScanner(_props: ScannerProps) {
  return null;
}
