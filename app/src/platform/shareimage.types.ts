// The share-a-picture port (package B1, the phone menu's "Share image…"): hands a PNG to the system's share (a sheet on iOS, the
// browser's share where it can send a file, else a download). `png` is base64 with no `data:` prefix, as the board's export gives it;
// `name` is a file name without its extension. It rejects when the platform cannot share; a person who dismisses the sheet is no failure.
export type ShareImage = (png: string, name: string) => Promise<void>;
