// A forced outcome for the device tests (package V4): the iOS simulator never asks for the local network, so `local_network_denied` cannot be had
// from the system there. A build made with EXPO_PUBLIC_AIWB_FORCE_OUTCOME=local_network_denied:<host> (app/e2e/run.mjs, flows with `devhooks=1`) ends every
// connection to that host as the module ends one the system refused, with the module's own outcome and detail (modules/aiwb-net/ios/NetSession.swift), so the
// app's words and its "Open settings" can be seen. Development builds only (__DEV__): a Release build has no such thing.
import { Problem, type Connector } from "@aiwb/conn";

const DETAIL = "the app may not use the local network"; // (the module's detail, NetSession.swift localNetworkDenied)

/** [outcome, host] from the build's value; null for none. */
function forced(): ["local_network_denied", string] | null {
  if (!__DEV__) return null;
  const v = process.env.EXPO_PUBLIC_AIWB_FORCE_OUTCOME ?? "";
  const at = v.indexOf(":");
  return at > 0 && v.slice(0, at) === "local_network_denied" ? ["local_network_denied", v.slice(at + 1)] : null;
}

/** The connector, with the forced outcome in front of the connections to the host. */
export function withForcedOutcome(inner: Connector): Connector {
  const f = forced();
  if (!f) return inner;
  const [outcome, host] = f;
  const refuse = (h: string) => { if (h === host) throw new Problem(outcome, DETAIL); };
  return {
    open: async (o) => { refuse(o.host); return inner.open(o); },
    readCertificate: async (o) => { refuse(o.host); return inner.readCertificate(o); },
  };
}
