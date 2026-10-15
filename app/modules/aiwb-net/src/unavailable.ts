// A module that is not there: the web build has no native network (it uses the page's own fetch), and a
// platform whose native side is not written yet answers the same. Every function rejects "not implemented";
// the listeners are real but nothing ever calls them.

import type { AiwbNetModule } from "./AiwbNet.ts";

const no = () => Promise.reject(new Error("not implemented"));

export function unavailableAiwbNet(): AiwbNetModule {
  return {
    openSession: no,
    readCertificate: no,
    fetch: no,
    stream: no,
    cancel: () => {},
    closeSession: () => {},
    localNetwork: no,
    addListener: () => ({ remove: () => {} }),
  };
}
