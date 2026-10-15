// The three viewports the browser checks of the new build run at (AD-80, goal 7.1), in Chromium:
//   desktop  1280×800, a mouse (no touch, scale 1)
//   tablet   Playwright's device "iPad Pro 11": 834×1194, touch, mobile, scale 2
//   phone    Playwright's device "iPhone 15": 393×852, touch, mobile, scale 3 (the device's own 659 high is Safari with its
//            bars; the app fills the screen)
// A check says where its behaviour applies: `export const viewports = ["desktop", "tablet", "phone"]` (the ones its
// parity rows' "Note for the app" name), and check() of dev/shot.mjs runs its body once at each. The layout the app picks at
// each is the one of the same name (app/src/ui/breakpoints.ts: phone below 700, tablet below 1100, desktop from 1100):
// dev/viewports.test.mjs holds the two files to each other, so a threshold moved there fails here.
// No dependency: Playwright is passed in (dev/shot.mjs loads it).

/** Every viewport, by name, in the order a check lists them. */
export const VIEWPORTS = {
  desktop: { width: 1280, height: 800, touch: false },
  tablet: { device: "iPad Pro 11", width: 834, height: 1194, touch: true },
  phone: { device: "iPhone 15", width: 393, height: 852, touch: true },
};

export const viewportNames = Object.keys(VIEWPORTS);

/** The layout of the app at a viewport (the same name: the width puts each in its own band). */
export const layoutOfViewport = (name) => name;

/** The layout of a window `width` wide, as app/src/ui/breakpoints.ts says it (kept equal by dev/viewports.test.mjs). */
export function layoutOfWidth(width) {
  return width < 700 ? "phone" : width < 1100 ? "tablet" : "desktop";
}

/** Whether the viewport has a finger and not a mouse: a check taps there (`page.tap`), clicks on the desktop. */
export const isTouch = (name) => !!VIEWPORTS[name]?.touch;

/** The options of a browser context for a viewport: `playwright` is the module dev/shot.mjs loadPlaywright() answers. `size`
 *  gives another window ([width, height]) with the viewport's device otherwise (a width the layout changes at); `scale`
 *  another device scale factor; `scheme` the system's theme, "light" or "dark". */
export function contextOptions(playwright, name, { size, scale, scheme } = {}) {
  const v = VIEWPORTS[name];
  if (!v) throw new Error(`no viewport "${name}": the viewports are ${viewportNames.join(", ")}`);
  let device = {};
  if (v.device) {
    const d = playwright.devices[v.device];
    if (!d) throw new Error(`this Playwright has no device "${v.device}"`);
    const { defaultBrowserType, ...rest } = d; // (the browser is always Chromium)
    device = rest;
  }
  const [width, height] = size ?? [v.width, v.height];
  return {
    ...device,
    viewport: { width, height },
    ...(v.device ? { screen: { width, height } } : {}),
    ...(scale ? { deviceScaleFactor: scale } : {}),
    ...(scheme ? { colorScheme: scheme } : {}),
  };
}

/** The names a check lists, checked: an error that names the mistake. */
export function checkViewports(list, where = "viewports") {
  if (!Array.isArray(list) || !list.length) throw new Error(`${where} must be a list of viewport names (${viewportNames.join(", ")})`);
  for (const n of list) if (!VIEWPORTS[n]) throw new Error(`${where}: no viewport "${n}" (${viewportNames.join(", ")})`);
  return list;
}
