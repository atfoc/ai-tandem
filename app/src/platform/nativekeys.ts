// The keys port over the aiwb-keys module (AD-73, package N3): every event the module emits goes to the handlers in the order they
// registered, as a KeyLike. The module takes the hardware keyboard's shortcuts while a handler is registered and gives them back
// with the last one. No React and no native import here, so Node tests it over the module's fake; keys.native.ts gives it the real one.
import type { AiwbKeysModule, KeyEvent, Subscription } from "../../modules/aiwb-keys/src/AiwbKeys.ts";
import type { KeyHandler, KeyLike, OnKey } from "./keys.types.ts";

/** The event as the object handlers get: `preventDefault` is remembered for the handlers after (`defaultPrevented`), and has nothing to
 *  prevent: the native side took the key already, for it is one of the shortcuts of the list. */
function keyLike(e: KeyEvent): KeyLike {
  let prevented = false;
  return {
    key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, repeat: e.repeat,
    preventDefault() { prevented = true; },
    stopPropagation() {},
    get defaultPrevented() { return prevented; },
  };
}

/** The keys port over `module`; with none (a build made before the module), a port that takes no key. */
export function keysOver(module: AiwbKeysModule | null): OnKey {
  const handlers: KeyHandler[] = [];
  let subscription: Subscription | null = null;
  const dispatch = (event: KeyEvent) => {
    const e = keyLike(event);
    for (const h of [...handlers]) {
      try { h(e); } catch (err) { console.error("a shortcut handler threw", err); } // one handler's failure is not the next one's
    }
  };
  return (handler) => {
    if (!module) return () => {};
    handlers.push(handler);
    if (handlers.length === 1) subscription = module.addListener("onKey", dispatch);
    return () => {
      const at = handlers.indexOf(handler);
      if (at < 0) return;
      handlers.splice(at, 1);
      if (handlers.length === 0) { subscription?.remove(); subscription = null; }
    };
  };
}

/** Tab and Shift+Tab on request over `module`: each call takes them and answers the function that gives them back (once; a second
 *  call does nothing). The module takes them from the first taker to the last give-back, and only while a handler of the port is
 *  registered: the keys come as key "Tab" through the port's handlers, like the shortcuts. With no module, or one made before
 *  `setTabKeys`, a no-op. */
export function tabOver(module: AiwbKeysModule | null): () => () => void {
  let takers = 0;
  return () => {
    if (!module?.setTabKeys) return () => {};
    if (++takers === 1) module.setTabKeys(true);
    let given = false;
    return () => {
      if (given) return;
      given = true;
      if (--takers === 0) module.setTabKeys?.(false);
    };
  };
}
