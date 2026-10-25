// What the phone's image viewer decides (ImageLarge.tsx): its two lines at the top, the page dots, which actions its bottom row has on which platform
// and why "Ask about it" is off, and the pinch's limits. Pure: no React and no react-native, so Node loads it.
import { noImagesLine } from "@aiwb/core/logic/chatimage.ts";
import { goneText } from "@aiwb/core/logic/remoteview.ts";

import type { Size } from "./shown.ts";

/** The size of a thumbnail in a sent message on the phone (goal 3.5), and the gap between them. The composer's strip keeps its own. */
export const PHONE_THUMB = { width: 116, height: 140, gap: 8 } as const;

/** Whose message the image came with, as the line under the name says it. */
export type Sender = "you" | "agent";

/** "Image 1 of 2 · your message" (a message's only image: "Image · your message"). */
export function viewerSub(at: number, count: number, from: Sender = "you"): string {
  const who = from === "you" ? "your message" : "Claude's reply";
  return `${count > 1 ? `Image ${at + 1} of ${count}` : "Image"} · ${who}`;
}

/** The page dots: one per image, the shown one on. None for a single image (and for none). */
export function pageDots(at: number, count: number): { on: boolean }[] {
  return count > 1 ? Array.from({ length: count }, (_, i) => ({ on: i === at })) : [];
}

export type ViewerAction = "share" | "save" | "ask";

/** The bottom row's actions, in order. `web`: Share needs the browser to share files (`navigator.canShare`), Save is a download. A device:
 *  iOS shares the picture's file, and its share sheet is also where "Save Image" is, so Save opens the same sheet (the app has no photo-library
 *  module, which would be a native dependency); Android's share (RN's) takes no file, so there are no Share and no Save there until a module
 *  gives one. */
export function viewerActions(o: { os: "web" | "ios" | "android"; canShareFiles: boolean; canAsk: boolean }): ViewerAction[] {
  const out: ViewerAction[] = [];
  if (o.os === "ios" || (o.os === "web" && o.canShareFiles)) out.push("share");
  if (o.os === "ios" || o.os === "web") out.push("save");
  if (o.canAsk) out.push("ask");
  return out;
}

/** Why a chat takes no "Ask about it" now (the image goes into its composer's draft, which a chat that cannot be changed does not take); "" when it does.
 *  server: the name of the chat's server. */
export function askWhy(o: { server: string; connected: boolean; gone: boolean; archived: boolean; model?: string }): string {
  if (o.gone) return goneText(o.server);
  if (o.archived) return "This chat is archived";
  if (!o.connected) return `${o.server} is not connected`;
  return o.model ? noImagesLine(o.model) : "";
}

export const MIN_ZOOM = 1, MAX_ZOOM = 5;

/** A scale kept between rest and the most the picture is zoomed to. */
export const clampScale = (s: number): number => (Number.isFinite(s) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s)) : MIN_ZOOM);

/** A pan of a zoomed picture kept so that no edge of it comes inside `box`: the picture drawn at `fit`, scaled by `scale` about its centre, which is
 *  the box's centre. A picture that is still smaller than the box along an axis stays centred on it. */
export function clampPan(pan: { x: number; y: number }, scale: number, fit: Size, box: Size): { x: number; y: number } {
  const room = (shown: number, inside: number) => Math.max(0, (shown * scale - inside) / 2);
  const mx = room(fit.width, box.width), my = room(fit.height, box.height);
  return { x: Math.min(mx, Math.max(-mx, pan.x)) + 0, y: Math.min(my, Math.max(-my, pan.y)) + 0 }; // (+ 0: no minus zero)
}

/** Whether a sideways pan moves the picture rather than going to another image: it does while the picture is zoomed (more than a hair above rest). */
export const zoomed = (scale: number): boolean => scale > MIN_ZOOM + 0.01;
