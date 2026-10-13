// The drawing of the README's hero board: the `create` list of one `apply` call of the board tool (see src/apply.ts),
// a request-flow diagram of a made-up checkout service. dev/readme-shots.mjs has the page apply it, so the elements are
// what an agent's call makes (bound labels, bound arrows), and then stores the scene it got.
const box = (key, label, x, y, w, h, c, more = {}) => ({ type: "rectangle", key, x, y, width: w, height: h, label: { text: label, fontSize: 20 }, roundness: "round", ...COLOURS[c], ...more });
const COLOURS = {
  grey:   { backgroundColor: "#e9ecef", strokeColor: "#495057", fillStyle: "solid" },
  violet: { backgroundColor: "#e5dbff", strokeColor: "#6741d9", fillStyle: "solid" },
  blue:   { backgroundColor: "#d0ebff", strokeColor: "#1971c2", fillStyle: "solid" },
  orange: { backgroundColor: "#ffe8cc", strokeColor: "#e8590c", fillStyle: "solid" },
  green:  { backgroundColor: "#d3f9d8", strokeColor: "#2f9e44", fillStyle: "solid" },
  yellow: { backgroundColor: "#fff3bf", strokeColor: "#f08c00", fillStyle: "solid" },
};
const arrow = (from, to, label, more = {}) => ({ type: "arrow", start: { key: from }, end: { key: to }, strokeColor: "#495057", strokeWidth: 2, endArrowhead: "arrow", ...(label ? { label: { text: label, fontSize: 16 } } : {}), ...more });

export const CREATE = [
  { type: "text", key: "title", x: 0, y: -150, text: "Checkout: from cart to confirmation", fontSize: 28, strokeColor: "#1e1e1e" },
  box("web", "Web and\nmobile apps", 0, 205, 140, 76, "grey"),
  box("gw", "API gateway", 235, 205, 140, 76, "violet"),
  box("co", "Checkout\nservice", 480, 185, 190, 116, "blue", { strokeWidth: 3 }),
  box("cache", "Cart cache\nRedis", 495, 400, 160, 76, "yellow"),
  box("stripe", "Stripe API", 830, -90, 150, 70, "grey", { strokeStyle: "dashed" }),
  box("pay", "Payments", 830, 30, 150, 70, "orange"),
  box("inv", "Inventory", 830, 150, 150, 70, "green"),
  box("db", "Orders DB\nPostgres", 830, 270, 150, 76, "yellow"),
  box("bus", "Event bus\nKafka", 830, 400, 150, 76, "violet"),
  box("mail", "Email worker", 830, 530, 150, 70, "green"),
  arrow("web", "gw", "HTTPS"),
  arrow("gw", "co", "/checkout"),
  arrow("co", "pay", "charge"),
  arrow("co", "inv", "reserve"),
  arrow("co", "db", "insert"),
  arrow("co", "bus", "publish"),
  arrow("co", "cache", "cart"),
  arrow("pay", "stripe", "token", { strokeStyle: "dashed" }),
  arrow("bus", "mail", "consume"),
  { type: "text", key: "note", x: 0, y: 360, text: "Idempotency key per cart:\na retried POST never\ncharges the card twice", fontSize: 16, strokeColor: "#e8590c" },
];
