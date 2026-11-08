# tldraw licence: what the prototype and a release need (goal 4.2, risk 8.6)

Checked **2026-11-08** against `tldraw@5.6.0` and `@tldraw/sync-core@5.6.0` (both `latest` on npm that day; `@tldraw/editor@5.6.0`
read too, since the licence check lives there). The tarballs came from `npm pack`. Paths below like `editor/src/...` are inside
the `@tldraw/editor@5.6.0` tarball (`package/src/...`), and `LICENSE` means
<https://github.com/tldraw/tldraw/blob/main/LICENSE.md>, which is byte-for-byte the same as the file at tag `v5.6.0`.

## Conclusion (for the findings report)

- **Licence type.** tldraw's own source-available licence, not open source. With no key it allows use **only in development**.
  `tldraw`, `@tldraw/editor` and `@tldraw/sync-core` are under the same terms: each `LICENSE.md` is the one line "This code is
  licensed under the tldraw license", and each `package.json` has `"license": "SEE LICENSE IN LICENSE.md"`.
- **What a release needs.** A **commercial licence key**. It is the only kind that allows commercial production use without a
  watermark. The other kinds don't fit: a trial lasts 100 days, one per business unit, and a hobby key is for non-commercial use,
  given at tldraw's discretion, with a watermark.
- **Cost.** **No public price.** The pricing page says "value-based pricing" and "Talk to sales", with discounted startup pricing
  "for new companies". The only figure around is about **$6,000/year**, reported when SDK 4.0 launched in September 2025. That
  comes from press and Hacker News, not from tldraw, so treat it as anecdotal. We would need a quote.
- **Watermark.** None with a commercial key. A hobby key must show the "made with tldraw" watermark. During development the
  canvas shows a "Get a license for production" button.
- **Without a key in production**, the editor logs errors and **stops rendering after 5 seconds** (a blank screen). It also
  sends a tracking ping to tldraw's CDN that includes the page URL.
- **The trap for us.** The desktop app loads the shipped web export from `file://`. That export is built with
  `NODE_ENV=production`, so tldraw treats it as **production**. Without a key, the board would go blank after 5 seconds in the
  shipped Electron app. A release key must be a "native" key whose hosts match the app's URL scheme (details in §3). The
  pricing page doesn't mention native apps, so this has to be arranged with sales.
- **Annual keys expire inside installed apps.** An annual key that lapses gives a 30-day grace period, then the same blank
  editor. A key built into a desktop or mobile app that people don't update must therefore be perpetual, or renewed and
  shipped before it expires (§3).
- **Headless board host.** The licence check doesn't run there: an `Editor` built directly has no licence manager, and SVG
  export draws no watermark. **Legally**, though, a server that gives users functionality is a "Production Environment", so
  the commercial licence has to cover it. The same goes for sync-core, which has no check in code but the same licence.
- **Blocker?** **None in the terms**, as long as we buy a commercial licence. Commercial use, a self-hosted server ("Host
  anywhere"), multiplayer ("Multiplayer sync included"), a public key embedded in the app, and bundling inside our app are all
  allowed. Three things are not settled until sales answers: the **price**, whether **one licence covers the desktop app, the
  mobile app and the server**, and whether it is a **native key that is perpetual** (or a renewal scheme that works for apps
  already installed). If the price or those answers are unacceptable, tldraw is out for a release. It would not be out for the
  prototype.
- **The prototype is fine** (goal 4.2). It counts as development in both of the places it runs: the web build served over
  `http://127.0.0.1`, and the Electron window when it loads a development bundle (§3). The prototype never removes the
  watermark or touches the licence check (that is forbidden by `LICENSE` line 29 and by goal 4.2).

## 1. Licence text

- Default terms. You may "Use the Software in Development Environments" and "Bundle the Software with your own projects"
  (`LICENSE` lines 19, 21). You agree "Not to use the Software in Production Environments" and "Not to disable, change, or
  interfere with the Software's License Key enforcement" (lines 28–29). Any distribution must include a verbatim copy of the
  licence, and the software can't be shipped as a standalone product (lines 32–33).
- "Production Environment" means any deployment "that operates on servers, cloud platforms, web applications, or where the
  software is used to provide functionality to end users". "Development Environment" means internal hosting "not accessible
  to end users, customers, or the public" (lines 9, 11). This is the legal test. The code's localhost test (§3) is only a
  technical approximation: an app shipped to users counts as production even if it serves its page from 127.0.0.1.
- The trial and commercial licences allow production use "for the specified period" (lines 36–42).
- "Technical enforcement … may collect and transmit usage data to tldraw" (line 50).
- tldraw.dev states: "permits use only in development"; "Trial, commercial, and hobby licenses each come with a license key";
  "The tldraw SDK will not work in production without a valid license key"; hobby licences require the "made with tldraw"
  watermark and are discretionary, for non-commercial projects; trials are 100 days, one per commercial unit; the packages
  "are not open source" (<https://tldraw.dev/community/license>).

## 2. Kinds of key and their cost

Source: <https://tldraw.dev/pricing>, read 2026-11-08.

| Key | Price | Who it's for | Watermark |
|---|---|---|---|
| Commercial ("SDK License") | not published: "Value-based pricing", "Talk to sales" | production use; "Full SDK feature access", "Multiplayer sync included", "Host anywhere" | no |
| Startup | discounted, amount not published | "new companies"; no published thresholds | no (it is a commercial licence) |
| Trial | free, 100 days, no card | one per business unit (`LICENSE` line 38) | no (code: an evaluation key is `licensed`, `editor/src/lib/license/LicenseManager.ts:736-737`) |
| Hobby | free | non-commercial, discretionary | **yes, required** |

There is no published price. The ~$6,000/year figure comes from third parties: <https://biggo.com/news/202509190115_tldraw_SDK_4.0_Licensing_Debate>
and <https://news.ycombinator.com/item?id=45293839>.

## 3. How the code decides development or production, and what it does (`@tldraw/editor@5.6.0`)

**Development** (`LicenseManager.ts:210-238`):
- `protocol === 'http:'`, **or** https on a loopback host (`localhost`, `127.x.x.x`, `::1`), **or** `NODE_ENV !== 'production'`.
- A `*.localhost` host (Tauri) is development only if `NODE_ENV !== 'production'`.
- The origin comes from `window.location.origin`. For an opaque origin (`file:`, custom schemes) it falls back to
  `protocol`/`hostname` (`:225-232`). So for **`file://`** and for any custom scheme, only `NODE_ENV` decides.

Our cases:
- The web build served over `http://127.0.0.1` is **development**, whatever `NODE_ENV` is.
- The Electron window with the shipped export is **production**. Electron does `win.loadFile(page)` (`desktop/main.js:90`),
  which is `file://`. `app/scripts/export-web.mjs:85` runs `expo export` without `--dev`, so the bundle has
  `NODE_ENV=production`.
- To keep the prototype's Electron window in development, it loads a development bundle (`expo export --dev`, or the dev
  server over `http://localhost`). It does not remove or alter the check.

**What each state does:**
- **Development without a key** gives state `unlicensed` (`:697-699`). There are no console errors
  (`outputNoLicenseKeyProvided` runs only when not in development, `:407-410`) and no tracking (`:294-296`). Every licensed
  feature is turned on (`:666-668`). The canvas shows a "Get a license for production" button linking to tldraw.dev/pricing
  (`editor/src/lib/license/Watermark.tsx:26, 51-77`).
- **Production without a valid key** (none, invalid, or the wrong domain) gives state `unlicensed-production`
  (`LicenseManager.ts:702-724`):
  - the console says "No tldraw license key provided! A license is required for production deployments.";
  - a ping goes to `<cdn>/watermarks/watermark-track.svg` carrying `url=window.location.href` (`:289-292, 319-346`);
  - after `LICENSE_TIMEOUT = 5000` ms the editor is replaced by an empty `<div data-testid="tl-license-expired">`
    (`editor/src/lib/license/LicenseProvider.tsx:34-39, 67-90`).
- **An expired key.** Annual and perpetual keys get a 30-day grace period (`GRACE_PERIOD_DAYS`, `:7, 555-578`). After that
  the state is `expired`, and the editor is hidden the same way (`:742-748`). A perpetual key keeps working for every tldraw
  version whose major and minor releases were published before its date (`:570-578`; 5.6.0's minor release is 2026-10-28,
  `editor/src/version.ts:5-8`). Evaluation keys have no grace period (`:588-593, 727-735`).
- **A hobby (`WITH_WATERMARK`) key** gives state `licensed-with-watermark` (`:762-764`). The watermark links to tldraw.dev
  (`Watermark.tsx:100`).

**The domain check** (`:489-535`): a key lists hosts (exact, `www.`, `*.domain`, or `*`). A key with the **`NATIVE_LICENSE`**
flag treats each host as a regular expression matched against `window.location.href`, for example `app-bundle:`
(`:23-25, 510-514`). That is how a `file://` Electron page, or an app's custom scheme, can be licensed. There is also a
VS Code webview case (`:524-531`).

**Where the key goes.** It is passed as the `licenseKey` prop of `<Tldraw>` / `<TldrawEditor>`, or as an environment
variable such as `TLDRAW_LICENSE_KEY` or `VITE_TLDRAW_LICENSE_KEY` (`LicenseProvider.tsx:42-43, 92-121`). Keys are checked
offline with a public key and "can be public" (<https://tldraw.dev/sdk-features/license-key>), so embedding one in the app
is fine.

**Feature flags.** In 5.6.0 the only consumer of the `collaboration`/`commenting` flags is the commenting UI
(`tldraw/src/lib/ui/hooks/useCommentingEnabled.ts:14`). Sync does not check a flag in this version, but a future version
could tie sync to `FEAT_COLLABORATION` (`:28-31`). The commercial key should include it.

## 4. The headless editor in Node, and `@tldraw/sync-core`

- The licence check exists only in the React tree. `<TldrawEditor>` wraps itself in `<LicenseProvider>` and renders
  `<Watermark />` (`editor/src/lib/TldrawEditor.tsx:369, 621, 811`).
- An `Editor` built directly, as the board host does, has no licence manager: "Undefined for editors created directly"
  (`editor/src/lib/editor/Editor.ts:1018-1025`). Its `licenseKey` option is declared (`:263`) and never read. Nothing
  watermarks the SVG export.
- `@tldraw/sync-core@5.6.0` contains no licence code at all (searching its `src` for "licen" finds nothing).
- **Legally** both are still "the Software" under the same licence. A server process that gives users functionality is a
  Production Environment (`LICENSE` line 9). A release therefore needs the commercial licence to cover the board host and the
  sync room as well, even though no check enforces it. The pricing page lists "Multiplayer sync included" and "Host
  anywhere". We still need sales to confirm in writing that one licence covers the server, the desktop app and the mobile
  app.

## 5. Questions for tldraw sales before a release

1. Price for our size (startup discount?).
2. A native key for the Electron `file://` page, and for the mobile app's board page (in a web view or a custom scheme).
3. Perpetual or annual. If annual: what happens to installed copies after renewal, and can a new key be delivered without
   shipping a new app build?
4. Confirmation that the self-hosted headless board host and the `@tldraw/sync-core` room are covered by the same licence.
5. `FEAT_COLLABORATION` included in the key.
