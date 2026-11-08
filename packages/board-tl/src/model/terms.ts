// The agent terms of a new board (design 7.2, 7.3): what an agent sends to `apply` and what `read_board` answers.
// This file is the contract; it is kept exactly as the design writes it.

export type StickyColor =
  | "light-yellow" | "yellow" | "orange" | "light-green" | "green" | "dark-green" | "cyan" | "light-pink" | "pink" | "violet"
  | "red" | "light-blue" | "blue" | "dark-blue" | "grey" | "black";
export type Color = "black" | "grey" | "white" | "red" | "orange" | "yellow" | "green" | "light-green"
  | "blue" | "light-blue" | "violet" | "pink";
export type ShapeKind = "rectangle" | "rounded" | "ellipse" | "triangle" | "diamond";
export type Size = "s" | "m" | "l" | "xl";                     // tldraw's size style, one-to-one
export type Align = "start" | "middle" | "end";
export type Arrowhead = "none" | "arrow" | "triangle" | "dot" | "diamond" | "bar";
export type Point = { x: number; y: number };
export type Ref = string;                                       // a ref of this apply, a "shape:…" id, or a key

type Common = { ref?: string; parent?: Ref | null };           // parent: a frame; null = the page

export type CreateSticky = Common & { op: "create"; type: "sticky"; x: number; y: number; w?: number;
  text?: string; color?: StickyColor; fontSize?: "auto" | Size; align?: Align };
export type CreateShape = Common & { op: "create"; type: "shape"; shape?: ShapeKind /* rectangle */; x: number; y: number;
  w?: number; h?: number; text?: string; fill?: Color | "none"; border?: Color; borderWidth?: Size;
  borderStyle?: "solid" | "dashed" | "dotted"; align?: Align; size?: Size };
export type CreateText = Common & { op: "create"; type: "text"; x: number; y: number; text: string;
  w?: number /* fixed width, wraps; absent = auto width */; size?: Size; color?: Color; align?: Align; bold?: boolean };
export type CreateConnector = Omit<Common, "parent"> & { op: "create"; type: "connector"; from: Ref | Point; to: Ref | Point;
  line?: "straight" | "curved" | "elbow"; start?: Arrowhead /* none */; end?: Arrowhead /* arrow */;
  text?: string; color?: Color; width?: Size; dash?: "solid" | "dashed" | "dotted" };
export type CreateFrame = Omit<Common, "parent"> & { op: "create"; type: "frame"; name?: string;
  x?: number; y?: number; w?: number; h?: number;   // absent: fitted around `contains` with 40 px padding
  contains?: Ref[]; color?: Color };

export type Update = { op: "update"; id: Ref } & Partial<{
  x: number; y: number; w: number; h: number; text: string; name: string; color: StickyColor | Color;
  fill: Color | "none"; border: Color; borderWidth: Size; borderStyle: "solid" | "dashed" | "dotted";
  shape: ShapeKind; size: Size; fontSize: "auto" | Size; align: Align; bold: boolean;
  from: Ref | Point; to: Ref | Point; line: "straight" | "curved" | "elbow"; start: Arrowhead; end: Arrowhead;
  width: Size; dash: "solid" | "dashed" | "dotted"; parent: Ref | null; contains: Ref[] }>;
export type Delete = { op: "delete"; id: Ref };                // a frame: its contents stay, moved to the page

export type Op = CreateSticky | CreateShape | CreateText | CreateConnector | CreateFrame | Update | Delete;
export type ApplyArgs = { board?: string; ops: Op[] };

export type TlElement = {
  id: string; key?: string; parent?: string;
  type: "sticky" | "shape" | "text" | "connector" | "frame" | "pen" | "image" | "other";
  x: number; y: number; w: number; h: number;          // page coordinates of the bounds, rounded to 0.1
  text?: string;                                        // rich text flattened to plain text, lines joined with "\n"
  from?: { id: string; key?: string } | Point; to?: { id: string; key?: string } | Point;   // connectors
  shownSize?: number;                                   // sticky: the font size in px it is drawn at after shrinking
  locked?: true;
} & Omit<ElementFields, "x" | "y" | "w" | "h" | "text" | "from" | "to">;

// Design 7.3 writes the tail of TlElement as
//   Partial<Omit<CreateSticky & CreateShape & CreateText & CreateConnector & CreateFrame, "op" | "type" | "ref" | "parent">>
// but that intersection is `never` (the `type` fields conflict), which makes every style field `undefined`. What it means is
// "any field of any create op, optional", which is what this says: each key of any create op, with the union of its types
// (so `color` is StickyColor | Color). The JSON is the same; only the TypeScript is repaired (deviations.md).
type CreateOp = CreateSticky | CreateShape | CreateText | CreateConnector | CreateFrame;
type FieldsOf<T> = T extends unknown ? Omit<T, "op" | "type" | "ref" | "parent"> : never;
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type ValueIn<T, K extends PropertyKey> = T extends unknown ? (K extends keyof T ? Exclude<T[K], undefined> : never) : never;
type ElementFields = { [K in KeysOfUnion<FieldsOf<CreateOp>>]?: ValueIn<FieldsOf<CreateOp>, K> };
