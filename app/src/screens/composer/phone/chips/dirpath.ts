// The folder sheet's path words (ux-improvements goal 3.6): the path as the path box draws it (the part before the folder's own name, then
// the name), the name Up goes to, the path of a subfolder. Pure, so a test reads them without React; `shown` paths are the server's home
// as "~" already (chat/hooks.ts tildify).

/** A path split for the path box: what comes before the folder's own name (with its slash) and the name. "~" and "/" are all name. */
export function pathParts(shown: string): { before: string; name: string } {
  const p = shown.length > 1 ? shown.replace(/\/+$/, "") : shown;
  const i = p.lastIndexOf("/");
  if (p === "" || p === "/" || i < 0) return { before: "", name: p || "/" };
  return { before: p.slice(0, i + 1), name: p.slice(i + 1) || "/" };
}

/** The name of the folder Up goes to, from the parent's shown path ("~" for the home, "/" for the root). */
export const upName = (shownParent: string): string => pathParts(shownParent).name;

/** A subfolder's path. */
export const childPath = (path: string, dir: string): string => path.replace(/\/+$/, "") + "/" + dir;
