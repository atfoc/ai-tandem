// MC1.2 (multiple-claude goal §1.2, screen 2; §4.3; plan D25, D27): the add/edit sheet of Settings › Claude accounts on the seed "MC", at the
// desktop (the form inside the accounts dialog) and the phone (a FormSheet). Add: Name, a folder through the folder browser a chat's folder
// uses (on the section's server), ▾ Advanced closed until pressed with the default image in Image, the note, Save → the mock got
// POST /api/aliases { name, mounts, image: "" } and the new row is in the list. Edit: the account's name and folders, a rename and a
// folder taken out → PATCH with them, the row says the new name and "0 folders mounted". Refusals shown in the sheet, which stays: a blank
// name; a folder listed twice; a file ("… is not a folder"); a folder that does not exist; the home folder ("… holds this computer's Claude
// login (~/.claude)"), the server's sentences as they come (the file and the missing folder come by core's openAccounts with `prefill`, as
// the chat's "Add it in Settings" puts a folder in the sheet: the browser itself lists folders only). Remove account → the confirmation names
// what is lost → the row goes.
import { callsOf, check, seed, until } from "../shot.mjs";
import { openAccounts, rowOf, sheet, shoot, textOf } from "./accounts.mjs";
import { byTid, layoutNow, press } from "./sel.mjs";

export const viewports = ["desktop", "phone"];

const J = JSON.stringify;
const SHOP = "/Users/demo/projects/shop", HOME = "/Users/demo";

await check("MC1.2 the account sheet: add, edit, the folder browser, Advanced, refusals, Remove account", async ({ url, viewport, open, fail }) => {
  await seed(url, "MC");
  const { page } = await open();
  const calls = callsOf(page);
  await openAccounts(page);
  const phone = layoutNow(page) === "phone";
  const S = () => sheet(page);
  const shown = (loc, ms = 10000) => until(() => loc.first().isVisible().catch(() => false), ms);
  const gone = (loc, ms = 10000) => until(async () => (await loc.count()) === 0, ms);
  const save = () => press(page, byTid(page, "account-save").last());
  const errorSays = async (want, what) => {
    const err = byTid(page, "account-error").last();
    if (!await until(async () => (await textOf(err)).includes(want), 8000)) fail(`${what}: the sheet's error says ${J(await textOf(err))}, not ${J(want)}`);
    if (!await S().isVisible()) fail(`${what}: the sheet closed`);
  };
  const folders = () => S().evaluate((el) => [...el.querySelectorAll('[data-testid="account-folder"]')].map((e) => e.dataset.path));
  /** + Add folder → the browser → the path typed → Use. */
  const addFolder = async (p) => {
    await press(page, byTid(S(), "account-add-folder"));
    const b = byTid(page, "account-folder-browser").last();
    if (!await shown(b)) throw new Error("+ Add folder opened no folder browser");
    await byTid(b, "dir-input").fill(p);
    await byTid(b, "dir-input").press("Enter");
    await until(async () => ((await byTid(b, "dir-use").textContent().catch(() => "")) ?? "").includes(p.split("/").pop()), 8000);
    await press(page, byTid(b, "dir-use"));
    await gone(byTid(page, "account-folder-browser"));
  };
  const closeSheet = async () => {
    if (phone) {
      await press(page, byTid(page, "sheet-left").last()); // Cancel
      const discard = page.getByRole("button", { name: "Discard changes", exact: true }).last();
      if (await shown(discard, 2000)) await press(page, discard);
    } else await press(page, byTid(page, "account-cancel").last());
    await gone(byTid(page, "account-sheet"));
  };

  // ---- add
  await press(page, byTid(page, "account-add", { server: "local" }).last());
  if (!await shown(S())) throw new Error("+ Add account opened no sheet");
  if ((await S().getAttribute("data-mode")) !== "add") fail(`the sheet's mode is ${await S().getAttribute("data-mode")}, not add`);
  const addText = await textOf(S());
  for (const w of ["Add account", "Name", "Folders to mount", "+ Add folder", "Each folder is mounted at the same path inside the container.", "▾ Advanced",
    "Login and chats are kept in the app's folder (not ~/.claude). Container:"]) if (!addText.includes(w)) fail(`the add sheet does not say ${J(w)}`);
  if (await byTid(S(), "account-remove").count()) fail("the add sheet has Remove account");
  if ((await byTid(S(), "account-name").getAttribute("placeholder")) !== "Claude · Work") fail("the name's placeholder is not \"Claude · Work\"");
  if (await byTid(S(), "account-image").count()) fail("Advanced is open before it is pressed");
  await byTid(S(), "account-name").fill("Claude · Side");
  await addFolder(SHOP);
  if (J(await folders()) !== J([SHOP])) fail(`after the browser the folders are ${J(await folders())}, not [${SHOP}]`);
  await press(page, byTid(S(), "account-advanced"));
  if (!await shown(byTid(S(), "account-image"))) fail("▾ Advanced shows no Image");
  else {
    if ((await byTid(S(), "account-image").inputValue()) !== "aiwb/claude:dev") fail(`Image holds ${J(await byTid(S(), "account-image").inputValue())}, not the default image`);
    if (!(await textOf(S())).includes("Empty = the default image. Folder or image changes apply on a container restart.")) fail("Image has no hint");
  }
  await shoot(page, `sheet-add-${viewport}`);
  let from = calls.length;
  await save();
  const post = await until(() => calls.slice(from).find((c) => c.method === "POST" && c.path === "/api/aliases"), 8000);
  if (!post) fail("Save sent no POST /api/aliases");
  else if (J(post.body) !== J({ name: "Claude · Side", mounts: [SHOP], image: "" })) fail(`the add sent ${J(post.body)}`);
  if (!await gone(byTid(page, "account-sheet"))) fail("the sheet stayed after the add");
  const added = byTid(page, "account-row", { server: "local" }).filter({ hasText: "Claude · Side" }).last();
  if (!await shown(added)) fail("the new account is not in the list");
  const newId = await added.getAttribute("data-id");

  // ---- edit: rename, a folder out
  await press(page, byTid(rowOf(page, newId), "account-edit"));
  if (!await shown(S())) throw new Error("Edit opened no sheet");
  if ((await S().getAttribute("data-mode")) !== "edit" || (await S().getAttribute("data-id")) !== newId) fail(`the sheet is ${await S().getAttribute("data-mode")} ${await S().getAttribute("data-id")}`);
  if (!(await textOf(S())).includes("Edit account")) fail("the edit sheet is not titled \"Edit account\"");
  if ((await byTid(S(), "account-name").inputValue()) !== "Claude · Side") fail("the edit sheet's name is not the account's");
  if (!(await textOf(S())).includes(`Container: aiwb-alias-${newId}`)) fail("the edit sheet's note does not name the container");
  await byTid(S(), "account-name").fill("Claude · Side 2");
  await press(page, byTid(S(), "account-folder-remove").first());
  if ((await folders()).length) fail("× left the folder in the list");
  from = calls.length;
  await save();
  const patch = await until(() => calls.slice(from).find((c) => c.method === "PATCH" && c.path === `/api/aliases/${newId}`), 8000);
  if (!patch) fail("Save sent no PATCH");
  else if (J(patch.body) !== J({ name: "Claude · Side 2", mounts: [], image: "" })) fail(`the edit sent ${J(patch.body)}`);
  await gone(byTid(page, "account-sheet"));
  if (!await until(async () => (await textOf(rowOf(page, newId))).includes("Claude · Side 2"), 8000)) fail("the row does not say the new name");
  if (!(await textOf(rowOf(page, newId))).includes("0 folders mounted")) fail(`the row says ${J(await textOf(rowOf(page, newId)))}, not 0 folders`);

  // ---- refusals, on Work
  await press(page, byTid(rowOf(page, "a_work0001"), "account-edit"));
  await shown(S());
  await byTid(S(), "account-name").fill("   ");
  from = calls.length;
  await save();
  await errorSays("An account needs a name", "a blank name");
  if (calls.slice(from).some((c) => c.method === "PATCH")) fail("a blank name was sent");
  await byTid(S(), "account-name").fill("Claude · Work");
  await addFolder(SHOP); // (listed already)
  await save();
  await errorSays(`${SHOP} is listed twice`, "a folder listed twice");
  await press(page, byTid(S(), "account-folder-remove").last());
  await addFolder(HOME);
  await save();
  await errorSays(`${HOME} holds this computer's Claude login (~/.claude)`, "the home folder");
  await shoot(page, `sheet-refusal-${viewport}`);
  await closeSheet();
  for (const [p, want] of [[`${HOME}/notes/todo.md`, "is not a folder"], [`${HOME}/nowhere`, "does not exist"]]) {
    await page.evaluate((p) => window.__aiwbAccounts.openAccounts({ server: "local", id: "a_work0001", prefill: p }), p);
    if (!await shown(S())) { fail(`the prefill of ${p} opened no sheet`); continue; }
    if (!(await folders()).includes(p)) fail(`the prefill of ${p}: the folders are ${J(await folders())}`);
    await save();
    await errorSays(`${p} ${want}`, `the folder ${p}`);
    await closeSheet();
  }

  // ---- Remove account
  await press(page, byTid(rowOf(page, newId), "account-edit"));
  await shown(S());
  await press(page, byTid(S(), "account-remove"));
  const dlg = byTid(page, "confirm-dialog").last();
  if (!await shown(dlg)) throw new Error("Remove account asked nothing");
  const said = await textOf(dlg);
  for (const w of ["Remove Claude · Side 2?", "Its login, sessions and settings are deleted and its container is removed. Its chats stay readable but can no longer continue."])
    if (!said.includes(w)) fail(`the confirmation says ${J(said)}: no ${J(w)}`);
  from = calls.length;
  await press(page, dlg.getByRole("button", { name: "Remove account", exact: true }).last());
  if (!await until(() => calls.slice(from).find((c) => c.method === "DELETE" && c.path === `/api/aliases/${newId}`), 8000)) fail("Remove sent no DELETE");
  if (!await gone(byTid(page, "account-row", { id: newId }))) fail("the removed account's row stayed");
  if (!await gone(byTid(page, "account-sheet"))) fail("the sheet stayed after the removal");
}, { viewports, page: false });
