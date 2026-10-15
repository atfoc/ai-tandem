// The parts of the .ipa server (scripts/serve-ipa.mjs) that touch no network or file: the manifest iOS reads, the page with the
// install link, the paths, the arguments. Tested by test/serve.test.ts.

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The manifest of an over-the-air install: iOS downloads the .ipa from `ipaUrl` (https, with a certificate the device trusts). */
export function manifestPlist({ ipaUrl, bundleId, version, title }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>items</key><array><dict>
    <key>assets</key><array><dict>
      <key>kind</key><string>software-package</string>
      <key>url</key><string>${esc(ipaUrl)}</string>
    </dict></array>
    <key>metadata</key><dict>
      <key>bundle-identifier</key><string>${esc(bundleId)}</string>
      <key>bundle-version</key><string>${esc(version)}</string>
      <key>kind</key><string>software</string>
      <key>title</key><string>${esc(title)}</string>
    </dict>
  </dict></array>
</dict></plist>
`;
}

/** The link that makes iOS ask "install?": it works only when opened in Safari on the device. */
export const installLink = (manifestUrl) => `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;

export function installPage({ manifestUrl, title, version, bundleId }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install ${esc(title)}</title>
<style>body{font:17px -apple-system,system-ui,sans-serif;margin:12vh 24px;text-align:center}a.b{display:inline-block;margin:24px 0;padding:14px 28px;border-radius:12px;background:#0a84ff;color:#fff;text-decoration:none;font-weight:600}small{color:#777}</style>
</head><body><h1>${esc(title)}</h1><small>${esc(version)} · ${esc(bundleId)}</small><br>
<a class="b" href="${esc(installLink(manifestUrl))}">Install</a><br>
<small>Open this page in Safari on an iPhone or iPad that is registered with the developer team.</small></body></html>
`;
}

/** The base address (`https://host/token/`) → the three addresses the server answers, as paths. */
export const routes = (token) => ({ page: `/${token}/`, manifest: `/${token}/manifest.plist`, ipa: `/${token}/app.ipa` });

/** The arguments of serve-ipa.mjs. */
export function parseServeArgs(argv) {
  const r = { help: false, ipa: "", port: 0, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") r.help = true;
    else if (a === "--ipa" || a === "--port") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) r.errors.push(`${a} needs a value`);
      else { r[a.slice(2)] = a === "--port" ? Number(v) : v; i++; }
    } else r.errors.push(`unknown argument ${a}`);
  }
  if (!Number.isInteger(r.port) || r.port < 0 || r.port > 65535) r.errors.push("--port is a port number");
  return r;
}

/** The page of the plain-http port: the certificate of this computer's authority and the steps to trust it, once per device. */
export function trustPage({ title }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trust this computer</title>
<style>body{font:17px -apple-system,system-ui,sans-serif;margin:8vh 24px;max-width:34em}a.b{display:inline-block;margin:16px 0;padding:14px 28px;border-radius:12px;background:#0a84ff;color:#fff;text-decoration:none;font-weight:600}</style>
</head><body><h1>Trust this computer, once</h1>
<p>iOS installs ${esc(title)} over the air only from https it trusts. This computer makes its own certificate; do this once per device, in Safari:</p>
<ol><li>Tap <a class="b" href="/ca.cer">Download the certificate</a> and allow it.</li>
<li>Settings &gt; General &gt; VPN &amp; Device Management &gt; <b>AI Whiteboard local CA</b> &gt; Install.</li>
<li>Settings &gt; General &gt; About &gt; Certificate Trust Settings &gt; switch on <b>AI Whiteboard local CA</b>.</li></ol>
<p>Then open the https link the script printed.</p></body></html>
`;
}
