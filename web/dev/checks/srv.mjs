// The constants of the Servers-on-the-phone checks (ux-improvements package S2; no dash in the name, the runner does not take it for a
// check): the fingerprints of the board's mockups, the setup text of a server a check pastes, and the ids dev/mock-ui.js (UXS2) seeds.
// The mock answers a fingerprint for an address from `flags.certs` (mock.mjs, the `// ux-s2` blocks), e.g.
//   mockEval(`flags.certs = { "studio.local": ${JSON.stringify(STUDIO)} }`)
// Every value here is made up and belongs to no real machine.
import { openFoot, byTid, press, back } from "./sel.mjs";
import { until } from "../shot.mjs";

/** 16 blocks of two hex pairs each ("3F9A") written as "3F:9A:…": the 32 pairs of a SHA-256 fingerprint. */
const print = (blocks) => blocks.split(" ").map((b) => `${b.slice(0, 2)}:${b.slice(2)}`).join(":");

export const BUILD = print("3F9A 0C21 5B7E A4D3 18C6 92F0 E7B5 6D14 CA38 0F9B 27E1 B6A5 4D82 91C7 F30E 7E4D");
export const CERT_NOW = print("8B47 1EC2 F903 6A5D D27B 40E8 9C16 B3FA 05D9 7E21 C84A 6F3B 1A70 E5C6 29DF 4B88");
export const CERT_OLD = print("5E21 A0C9 7B44 D1F8 0C3A 92E6 4F17 B85D 2A60 E9C3 71BD 08F4 C6A2 3D95 F14E 8B07");
export const STUDIO = print("C41E 9B07 5A3D E2F8 0B6C 71A9 D35E 48F2 A907 3C1B 6E84 F25D 19C0 B7A6 2D58 E3F1");
export const IMPOSTOR = print("7D20 E91A 44BC 0F63 B815 2CA7 9E04 D6F1 3B59 A0C8 57E2 1D9F C63A 08B4 E7D1 4F25");

export const STUDIO_ADDRESS = "https://studio.local:4790";
export const STUDIO_HOST = "studio.local";
/** An obviously fake secret (the form takes 1–256 printable characters). */
export const STUDIO_SECRET = "s2-test-secret-not-real-0001";
/** The text `setup-remote.sh` / `scripts/server-code.sh` make for that server, in the format parseServerCode reads (codeText of
 *  packages/core/src/logic/servercode.ts): { addresses: [STUDIO_ADDRESS], secret: STUDIO_SECRET, fingerprint: STUDIO }.
 *  Proved once with `node -e`: `import("./web/dev/checks/srv.mjs")` and `import("./packages/core/src/logic/servercode.ts")` (Node 24 strips the
 *  types), parseServerCode(STUDIO_CODE) answered ok:true with this address, this secret and this fingerprint back. */
export const STUDIO_CODE = `Addresses:\n  ${STUDIO_ADDRESS}\nFingerprint: ${STUDIO}\nSecret: ${STUDIO_SECRET}\n`;

/** The entry ids dev/mock-ui.js UXS2 seeds (apart from SEC's). */
export const IDS = { build: "s_build", home: "s_home", attic: "s_attic", certbox: "s_certbox", mini: "s_mini", slow: "s_slow" };
export const SEEDED = Object.values(IDS);

// ---- the phone's way to the Servers screens (shared by the checks that used the old dialog's opener at the phone)

/** The phone: Home's gear, Settings' Servers row, S2's list (`srv-list`) with its first row drawn. */
export async function openServersScreen(page) {
  await openFoot(page, "servers-btn");
  await byTid(page, "srv-list").last().waitFor({ state: "visible", timeout: 15000 });
  await byTid(page, "srv-row").first().waitFor({ state: "visible", timeout: 15000 });
}

/** The phone: the list, then a row's detail (`srv-facts`); `name` is the row's name as the list draws it ("This computer"). */
export async function openServerDetail(page, name = "This computer") {
  await openServersScreen(page);
  await press(page, byTid(page, "srv-row").filter({ has: page.getByText(name, { exact: true }) }).first());
  await byTid(page, "srv-facts").last().waitFor({ state: "visible", timeout: 15000 });
  return byTid(page, "srv-facts").last();
}

/** This computer's detail: the owner's things (`srv-owner`, drawn where the transport offers them: the test host's `http`) and what they hold. */
export function ownerOf(page) {
  const owner = byTid(page, "srv-owner").last();
  const facts = byTid(page, "srv-facts").last();
  return {
    owner, facts,
    word: () => facts.getAttribute("data-word"),
    text: async (loc = owner) => ((await loc.first().textContent({ timeout: 2000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim(),
    restart: byTid(owner, "servers-restart"), retry: byTid(owner, "servers-retry"),
    reason: byTid(owner, "servers-reason"), mcp: byTid(owner, "servers-mcp"), line: byTid(owner, "servers-owner-line"),
    /** The owner's buttons by their words, in the order drawn. */
    buttons: async () => (await Promise.all(["servers-restart", "servers-retry"].map(async (id) => (await byTid(owner, id).count()) ? [(await byTid(owner, id).first().textContent()).trim()] : []))).flat(),
  };
}

/** Back out of the Servers screens to Home. */
export async function leaveServers(page) {
  for (let i = 0; i < 6 && await byTid(page, "srv-list").count(); i++) if (!await back(page)) break;
  await until(async () => !await byTid(page, "srv-list").count() && !await byTid(page, "srv-facts").count(), 5000);
}
