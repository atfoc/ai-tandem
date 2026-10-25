// When a thread follows its end (B-SM-06 to B-SM-09). The old page pinned the scroller to the bottom while the user had not scrolled
// up, and stopped when the user was more than 40 px from the end; this is the same rule over the events of a scroller.

/** The distance from the end under which the thread follows it. */
export const FOLLOW_PX = 40;

export type Scroll = { offset: number; content: number; view: number };

export const distanceFromEnd = (s: Scroll): number => s.content - s.offset - s.view;

/** Whether the thread follows its end after a scroll event. `was`: whether it did before; `last`: the offset of the event before.
 *  A scroll up decides (the user left the end, or did not go far); a scroll down to within 40 px follows again; an event with the
 *  offset where it was is content that grew or a view that got shorter, which the thread follows if it followed, and never ends. */
export function follows(was: boolean, last: number, s: Scroll): boolean {
  const near = distanceFromEnd(s) < FOLLOW_PX;
  if (s.offset < last - 1) return near;
  return near || was;
}

/** Whether the "↓ Latest" pill shows (phone, goal 3.5): the thread does not follow its end because the person scrolled up, and its content
 *  has grown since they left it (`leftAt`: the content's height when they did, null while the thread follows), or its last message changed since
 *  (`fresh`: the list measures only the rows it draws, so a row that grows out of its window leaves the content's height as it was). */
export function showLatest(following: boolean, leftAt: number | null, content: number, fresh = false): boolean {
  return !following && leftAt !== null && (fresh || content > leftAt + 1);
}
