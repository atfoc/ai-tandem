// Where an attached image stands in what the model gets: before the text.
//
// The app hands the images of a user's message to pi in the `images` list of
// its `prompt` command, never as files. pi itself builds the user message from
// that command as one text part followed by the images (AgentSession.prompt in
// pi's core/agent-session: `[{ type: "text", text }]`, then
// `push(...images)`), and every provider layer of pi sends the parts in the
// order they have. Nothing in the `prompt` command chooses another order. The
// app's rule for every agent is the opposite one: the image stands before the
// user's text.
//
// pi calls a `context` handler before each model request, with a copy of the
// conversation that is used for that request alone. imagesFirst moves the image
// parts of every user message to the front there. The session file keeps the
// message as pi wrote it; the order is made again at every request, the same
// way each time, so what a provider caches of earlier turns stays valid.
//
// The messages are changed in place. A handler that returns another list makes
// pi put its system messages back as one leading message; one that returns
// nothing leaves them where they are.
//
// Dependency-free, so it is unit-testable with
// `node --test --experimental-strip-types` and no pi or node_modules.

type Part = { type?: unknown };

function isImage(part: unknown): boolean {
  return typeof part === "object" && part !== null && (part as Part).type === "image";
}

/**
 * imagesFirst puts the image parts of every user message in messages before
 * its other parts. The images keep their order among themselves, and so do the
 * other parts. A message of another role (a tool result with a picture, an
 * assistant's answer), one whose content is a plain string and one whose
 * images already lead are left as they are. It returns how many messages it
 * changed.
 */
export function imagesFirst(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let changed = 0;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const m = message as { role?: unknown; content?: unknown };
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    const parts = m.content as unknown[];
    const images = parts.filter(isImage);
    if (images.length === 0 || parts.slice(0, images.length).every(isImage)) continue;
    m.content = [...images, ...parts.filter((part) => !isImage(part))];
    changed += 1;
  }
  return changed;
}
