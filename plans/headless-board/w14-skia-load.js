const { Canvas } = require(process.argv[2] + "/engine/node_modules/skia-canvas");
const c = new Canvas(40, 20); const x = c.getContext("2d"); x.fillStyle = "red"; x.fillRect(0, 0, 40, 20);
c.toBuffer("png").then((b) => console.log("OK skia-canvas drew a PNG of", b.length, "bytes"));
