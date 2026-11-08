// The names each DOM's window gives to globalThis (dom.ts, dom-happy.ts, dom-linkedom.ts).
/** Names copied from the window onto globalThis (when Node does not already have them). */
export const GLOBALS = [
  'window', 'document', 'navigator', 'location', 'Node', 'Element', 'HTMLElement', 'HTMLDivElement', 'HTMLSpanElement',
  'HTMLImageElement', 'HTMLCanvasElement', 'HTMLStyleElement', 'HTMLAnchorElement', 'HTMLInputElement', 'HTMLTextAreaElement',
  'SVGElement', 'SVGSVGElement', 'SVGGraphicsElement', 'DocumentFragment', 'Document', 'Text', 'Comment', 'Range',
  'Selection', 'DOMParser', 'XMLSerializer', 'MutationObserver', 'getComputedStyle', 'Image', 'FileReader',
  'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'WheelEvent', 'UIEvent', 'CSSStyleDeclaration',
  'customElements', 'ShadowRoot', 'NodeFilter', 'TreeWalker', 'getSelection', 'StyleSheet', 'CSSStyleSheet',
]
