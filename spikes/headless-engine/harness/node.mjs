// The headless side of the faithfulness harness: the Node engine (../out/engine.mjs, `node ../build.mjs`).
export async function startNode() {
  const e = await import("../out/engine.mjs");
  return {
    canvas: e.lib.name,
    req: (op) => e.request(op),
    measure: (fonts, texts) => { const c = document.createElement("canvas").getContext("2d"); return fonts.map((f) => { c.font = f; return texts.map((t) => c.measureText(t).width); }); },
    engine: e,
  };
}
