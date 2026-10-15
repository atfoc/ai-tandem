// The clipboard port: puts a text on the system's clipboard. It rejects when the platform refuses (a browser without the
// permission), so the caller does not say "Copied" for nothing.
export type CopyText = (text: string) => Promise<void>;
