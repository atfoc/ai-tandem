import { test } from "node:test";
import assert from "node:assert/strict";
import { readBoardText, readElements, readElementsById, richTextToPlain } from "../src/model/read.ts";
import { PAGE, arrow, bind, draw, frame, geo, image, note, rich, sticky, text } from "./records.ts";

const one = (records: object[]) => {
  const els = readElements([PAGE, ...records] as never);
  assert.equal(els.length, 1);
  return els[0];
};

test("a tldraw note reads as a sticky, with its shrunk font size", () => {
  assert.deepEqual(
    one([note("shape:n", { x: 10, y: 20, key: "n1", props: { richText: rich("Idea"), color: "light-red", fontSizeAdjustment: 0.5 } })]),
    { id: "shape:n", key: "n1", type: "sticky", x: 10, y: 20, w: 200, h: 200, text: "Idea", color: "light-pink", align: "middle", fontSize: "auto", shownSize: 11 },
  );
  // growY makes it taller; scale scales it.
  const tall = one([note("shape:n", { props: { growY: 50, scale: 2 } })]);
  assert.deepEqual([tall.w, tall.h, tall.shownSize], [400, 500, 44]);
  // A note's ink reads as the sticky colour of the same name, else the nearest.
  const colorOf = (color: string) => one([note("shape:n", { props: { color } })]).color;
  assert.deepEqual(["yellow", "light-blue", "black", "light-violet", "white"].map(colorOf), ["yellow", "light-blue", "black", "violet", "grey"]);
});

test("our sticky reads its own colour names, size and fixed font size", () => {
  assert.deepEqual(
    one([sticky("shape:s", { x: -5, props: { w: 300, h: 300, richText: rich("a\nb"), color: "dark-blue", fontSize: 32, fitted: 32, align: "start-legacy" } })]),
    { id: "shape:s", type: "sticky", x: -5, y: 0, w: 300, h: 300, text: "a\nb", color: "dark-blue", align: "start", fontSize: "l", shownSize: 32 },
  );
  // automatic (0): shownSize is the fitted size
  const shown = one([sticky("shape:s", { props: { fontSize: 0, fitted: 13.37 } })]);
  assert.deepEqual([shown.fontSize, shown.shownSize, shown.w, shown.color], ["auto", 13.4, 200, "light-yellow"]);
  // a fixed px that is no Size reads as the nearest Size
  const near = (fontSize: number) => one([sticky("shape:s", { props: { fontSize, fitted: fontSize } })]).fontSize;
  assert.deepEqual([12, 19, 21, 29, 39, 41, 100].map(near), ["s", "s", "m", "l", "l", "xl", "xl"]);
});

test("a geo reads as a shape with fill, border and growY", () => {
  assert.deepEqual(
    one([geo("shape:g", { x: 300, y: 0, key: "s1", props: { w: 200, h: 100, growY: 12.34, richText: rich("API") } })]),
    {
      id: "shape:g", key: "s1", type: "shape", shape: "rectangle", x: 300, y: 0, w: 200, h: 112.3, text: "API",
      fill: "none", border: "black", borderWidth: "m", borderStyle: "solid", align: "middle", size: "m",
    },
  );
  // fill colour = fillColor, border = color, border width = size, label size = labelSize (styles.ts)
  const filled = one([geo("shape:g", { props: { geo: "ellipse", fill: "fill", fillColor: "light-red", color: "blue", dash: "dashed", size: "l", labelSize: "s" } })]);
  assert.deepEqual(
    [filled.shape, filled.fill, filled.border, filled.borderWidth, filled.borderStyle, filled.size],
    ["ellipse", "pink", "blue", "l", "dashed", "s"],
  );
  const rounded = one([geo("shape:g", { props: { geo: "rounded-rectangle", fill: "solid", fillColor: "white", size: "xl", labelSize: "xl" } })]);
  assert.deepEqual([rounded.shape, rounded.fill, rounded.borderWidth, rounded.size], ["rounded", "white", "xl", "xl"]);
  // fill none hides the fill colour
  assert.equal(one([geo("shape:g", { props: { fill: "none", fillColor: "red" } })]).fill, "none");
  // A geo kind the agent has no name for.
  assert.equal(one([geo("shape:g", { props: { geo: "star" } })]).type, "other");
});

test("a text reads its style, bold from its marks, and an estimated size", () => {
  const boldText = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Hi", marks: [{ type: "bold" }] }] }],
  };
  const t = one([text("shape:t", { x: 1, y: 2, props: { richText: boldText, size: "l", color: "red", textAlign: "middle" } })]);
  assert.deepEqual(
    { ...t, w: undefined, h: undefined },
    { id: "shape:t", type: "text", x: 1, y: 2, w: undefined, h: undefined, text: "Hi", size: "l", color: "red", align: "middle", bold: true },
  );
  assert.ok(t.w > 0 && t.h >= 36 * 1.35 - 0.1);
  assert.equal(one([text("shape:t", { props: { richText: rich("plain") } })]).bold, false);
  // A fixed width is kept; more lines make it taller.
  const fixed = one([text("shape:t", { props: { autoSize: false, w: 120, richText: rich("a\nb\nc") } })]);
  assert.equal(fixed.w, 120);
  assert.equal(fixed.h, round1(3 * 24 * 1.35));
});

test("an Editor's bounds win over the estimate", () => {
  const els = readElements([PAGE, text("shape:t", { props: { richText: rich("x") } })] as never, {
    pageBounds: (id) => (id === "shape:t" ? { x: 5, y: 6, w: 70.04, h: 32.4 } : undefined),
  });
  assert.deepEqual([els[0].x, els[0].y, els[0].w, els[0].h], [5, 6, 70, 32.4]);
});

test("a connector names the elements its ends attach to, by id and key", () => {
  const a = geo("shape:a", { x: 0, y: 0, key: "n1", props: { w: 100, h: 100 } });
  const b = geo("shape:b", { x: 300, y: 0, props: { w: 100, h: 100 } });
  const c = arrow("shape:c", { x: 50, y: 50, props: { richText: rich("calls"), start: { x: 0, y: 0 }, end: { x: 300, y: 0 } } });
  const els = readElements([PAGE, a, b, c, bind(c.id, a.id, "start"), bind(c.id, b.id, "end")] as never);
  assert.deepEqual(els[2], {
    id: "shape:c", type: "connector", x: 50, y: 50, w: 300, h: 0,
    from: { id: "shape:a", key: "n1" }, to: { id: "shape:b" },
    line: "straight", start: "none", end: "arrow", text: "calls", color: "black", width: "m", dash: "solid",
  });
});

test("a connector's free end is a page point; a bend makes it curved", () => {
  const f = frame("shape:f", { x: 100, y: 100, props: { w: 500, h: 500 } });
  const a = geo("shape:a", { x: 0, y: 0, parentId: f.id });
  const c = arrow("shape:c", {
    x: 10, y: 20, parentId: f.id,
    props: { start: { x: 0, y: 0 }, end: { x: 200, y: 0 }, bend: 30, arrowheadStart: "dot", arrowheadEnd: "pipe", kind: "arc" },
  });
  const els = readElements([PAGE, f, a, c, bind(c.id, a.id, "start", { x: 1, y: 0.5 })] as never);
  const conn = els[2];
  assert.deepEqual(conn.from, { id: "shape:a" });
  assert.deepEqual(conn.to, { x: 310, y: 120 }); // (10 + 200, 20) in the frame, moved by the frame
  assert.deepEqual([conn.line, conn.start, conn.end], ["curved", "dot", "bar"]);
  // The start is the precise anchor on the shape (100, 50 in the frame → 200, 150); the bend moves the middle 30 px off the
  // chord, to below both ends here.
  assert.equal(conn.parent, "shape:f");
  assert.equal(conn.x, 200);
  assert.equal(conn.y, 120);
  assert.equal(conn.h, 43.9); // the middle: (255, 135) + 30 × (30, 110) / |(30, 110)|, at y 163.9
  assert.equal(readElements([PAGE, arrow("shape:e", { props: { kind: "elbow" } })] as never)[0].line, "elbow");
});

test("frames come before what they hold, children read in page coordinates, nested and rotated", () => {
  const outer = frame("shape:f1", { x: -40, y: -80, key: "f1", props: { w: 620, h: 300, name: "Sprint" } });
  const inner = frame("shape:f2", { x: 100, y: 100, parentId: outer.id, props: { w: 200, h: 100, name: "Inner", color: "green" } });
  const kid = geo("shape:k", { x: 10, y: 10, parentId: inner.id, props: { w: 20, h: 10 } });
  const turned = geo("shape:r", { x: 0, y: 0, rotation: Math.PI / 2, props: { w: 100, h: 50 } });
  // Page order is by index: give them in a shuffled order.
  const els = readElements([kid, turned, PAGE, inner, outer] as never);
  assert.deepEqual(
    els.map((e) => [e.id, e.parent, e.x, e.y, e.w, e.h]),
    [
      ["shape:f1", undefined, -40, -80, 620, 300],
      ["shape:f2", "shape:f1", 60, 20, 200, 100],
      ["shape:k", "shape:f2", 70, 30, 20, 10],
      ["shape:r", undefined, -50, 0, 50, 100],
    ],
  );
  assert.deepEqual(els[0], { id: "shape:f1", key: "f1", type: "frame", x: -40, y: -80, w: 620, h: 300, name: "Sprint", color: "black" });
  assert.equal(els[1].color, "green");
});

test("a rotated frame turns what it holds", () => {
  const f = frame("shape:f", { x: 100, y: 0, rotation: Math.PI, props: { w: 100, h: 100 } });
  const k = geo("shape:k", { x: 10, y: 10, parentId: f.id, props: { w: 20, h: 20 } });
  const els = readElements([PAGE, f, k] as never);
  assert.deepEqual([els[1].x, els[1].y, els[1].w, els[1].h], [70, -30, 20, 20]);
});

test("a pen reads its points' bounds; an image and other shapes their box; locked is said", () => {
  const pen = draw("shape:p", [{ x: 0, y: 0 }, { x: 120, y: 40 }, { x: 60, y: -10 }], { x: 10, y: 400, props: { color: "violet", size: "s" } });
  assert.deepEqual(one([pen]), { id: "shape:p", type: "pen", x: 10, y: 390, w: 120, h: 50, color: "violet", width: "s" });
  assert.deepEqual(one([image("shape:i", { x: 1, y: 1, isLocked: true })]), { id: "shape:i", type: "image", x: 1, y: 1, w: 300, h: 200, locked: true });
  const other = one([{ ...geo("shape:o"), type: "embed", props: { w: 30, h: 40, url: "" } }]);
  assert.deepEqual(other, { id: "shape:o", type: "other", x: 0, y: 0, w: 30, h: 40 });
});

test("only the first page is read unless one is named", () => {
  const page2 = { ...PAGE, id: "page:two", index: "a2" };
  const records = [PAGE, page2, geo("shape:a"), geo("shape:b", { parentId: page2.id })];
  assert.deepEqual(readElements(records as never).map((e) => e.id), ["shape:a"]);
  assert.deepEqual(readElements(records as never, { pageId: "page:two" }).map((e) => e.id), ["shape:b"]);
});

test("readElementsById picks the asked elements, in z-order", () => {
  const records = [PAGE, geo("shape:a"), geo("shape:b"), geo("shape:c")];
  assert.deepEqual(readElementsById(records as never, ["shape:c", "shape:a"]).map((e) => e.id), ["shape:a", "shape:c"]);
});

test("the read_board text: the header and one JSON line per element", () => {
  const f = frame("shape:a1", { x: -40, y: -80, key: "f1", props: { w: 620, h: 300, name: "Sprint" } });
  const n = note("shape:b2", { x: 40, y: 80, parentId: f.id, key: "n1", props: { richText: rich("Idea") } });
  const out = readBoardText({ id: "b_k2j4h1x9", name: "Sprint" }, [PAGE, f, n] as never);
  assert.equal(
    out,
    [
      'Board "Sprint" (b_k2j4h1x9), a new board. 2 elements. Coordinates are page px; parent names the frame that holds an element.',
      '{"id":"shape:a1","key":"f1","type":"frame","x":-40,"y":-80,"w":620,"h":300,"name":"Sprint","color":"black"}',
      '{"id":"shape:b2","key":"n1","type":"sticky","parent":"shape:a1","x":0,"y":0,"w":200,"h":200,"text":"Idea","color":"yellow","align":"middle","fontSize":"auto","shownSize":22}',
    ].join("\n"),
  );
  assert.equal(
    readBoardText({ id: "b_1", name: 'A "q"' }, [PAGE, geo("shape:x")] as never).split("\n")[0],
    'Board "A \\"q\\"" (b_1), a new board. 1 element. Coordinates are page px; parent names the frame that holds an element.',
  );
  assert.equal(readBoardText({ id: "b_1", name: "E" }, [PAGE] as never).split("\n").length, 1);
});

test("rich text flattens paragraphs, lists and hard breaks", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }] }] },
      { type: "paragraph" },
    ],
  };
  assert.equal(richTextToPlain(doc), "a\nb\nc\n");
  assert.equal(richTextToPlain(rich("x\ny")), "x\ny");
});

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
