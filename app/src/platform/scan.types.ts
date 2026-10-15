// The scan port (S12, goal 4.7): a camera that reads the QR code scripts/server-code.sh shows. Device only: the web build draws no scan button
// (`canScan` false) and the check of the paste path does not reach it; the scan path is checked on a device (V4).
export type ScannerProps = {
  /** Gives a text the camera read; answers the words of a refusal (the camera goes on looking), or null when the text was taken. */
  onText(text: string): string | null;
  /** The person left the scanner. */
  onClose(): void;
};
