// The picture cache over expo-file-system (AD-25). The module is given, so that the tests can give a fake of it; the
// phone gives `expo-file-system` itself (transport.native.ts). Only the part used is typed here.
import type { PictureCache } from "./picturefile.ts";

export interface FsFile {
  readonly uri: string;
  readonly exists: boolean;
  create(options?: { overwrite?: boolean; intermediates?: boolean }): void;
  write(content: Uint8Array): void;
  delete(): void;
  bytes(): Promise<Uint8Array>;
  readonly size: number;
  move(destination: unknown, options?: { overwrite?: boolean }): Promise<void>;
}
export interface FsDirectory { create(options?: { intermediates?: boolean; idempotent?: boolean }): void }
export interface FsModule {
  // The parts of a path: a `file://` address, or a directory this module made.
  File: new (...parts: any[]) => FsFile;
  Directory: new (...parts: any[]) => FsDirectory;
  Paths: { readonly cache: FsDirectory };
}

export const PICTURES_FOLDER = "aiwb-pictures";

export function createPictureCache(fs: FsModule): PictureCache {
  let n = 0;
  return {
    find(server, image) {
      const f = new fs.File(fs.Paths.cache, PICTURES_FOLDER, server, image);
      return f.exists ? f.uri : null;
    },
    async put(server, image, data) {
      const dir = new fs.Directory(fs.Paths.cache, PICTURES_FOLDER, server);
      dir.create({ intermediates: true, idempotent: true });
      // Written beside its place and moved into it: a picture that was cut short by the app ending is never one
      // that `find` answers.
      const tmp = new fs.File(dir, `${image}.${Date.now()}-${++n}.tmp`);
      const dest = new fs.File(dir, image);
      try {
        tmp.create({ overwrite: true });
        tmp.write(data);
        await tmp.move(dest, { overwrite: true });
      } catch (e) {
        try { if (tmp.exists) tmp.delete(); } catch { /* the cache folder is the system's */ }
        throw e;
      }
      return dest.uri;
    },
  };
}
