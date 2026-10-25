// The clipboard port: puts a text on the system's clipboard. It rejects when the platform refuses (a browser without the
// permission), so the caller does not say "Copied" for nothing.
export type CopyText = (text: string) => Promise<void>;

/** The text on the clipboard, only where the platform says so without asking and without a press (the web build when `clipboard-read` is
 *  already granted); null everywhere else, and always on a device: iOS asks the person on every read, so a read is the press's. */
export type PeekText = () => Promise<string | null>;

/** The text on the clipboard, for a press (the add flow's "Paste setup text"). Rejects when the platform refuses. */
export type ReadText = () => Promise<string>;
