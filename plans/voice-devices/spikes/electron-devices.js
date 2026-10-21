'use strict';
// Spike (vd-architecture): what the desktop window's Chromium (Electron, as desktop/package.json pins it) gives the page for audio devices.
// Run: SPIKE_PAGE=<an empty .html file> <electron binary> plans/voice-devices/spikes/electron-devices.js [fake] [check]   (a file:// page: a data: URL has no mediaDevices)
//   fake   Chromium's fake capture devices (--use-fake-device-for-media-stream, --use-fake-ui-for-media-stream), then getUserMedia
//   check  a permission *check* handler that answers true for "media" (labels before getUserMedia?)
// Prints one JSON line. Device names are not printed (they are this machine's); only counts, whether labels/ids are empty, and the API results.
const { app, BrowserWindow, session } = require('electron');
const fake = process.argv.includes('fake');
const check = process.argv.includes('check');
if (fake) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}
setTimeout(() => { console.log('{"timeout":true}'); app.exit(2); }, 45000);
app.whenReady().then(async () => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  if (check) ses.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  win.webContents.on('console-message', (e, _l, msg) => { const m = (e && e.message) || msg; if (String(m).startsWith('step ')) console.log(String(m)); });
  await win.loadFile(process.env.SPIKE_PAGE || require('node:path').join(require('node:os').tmpdir(), 'vd-arch-page.html'));
  const out = await win.webContents.executeJavaScript(`(async () => {
    const r = {}; const T = (name, p, ms = 5000) => { console.log('step ' + name); return Promise.race([p, new Promise((_, no) => setTimeout(() => no(Object.assign(new Error('timeout'), { name: 'Timeout' })), ms))]); };
    const sum = (list) => list.reduce((a, d) => {
      const k = d.kind; a[k] = a[k] || { n: 0, labelled: 0, withId: 0, defaultId: 0, communicationsId: 0, groups: new Set() };
      a[k].n++; if (d.label) a[k].labelled++; if (d.deviceId) a[k].withId++;
      if (d.deviceId === 'default') a[k].defaultId++; if (d.deviceId === 'communications') a[k].communicationsId++;
      a[k].groups.add(d.groupId); return a; }, {});
    const flat = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v, groups: v.groups.size }]));
    r.ua = navigator.userAgent.match(/Chrome\\/[0-9.]+/)?.[0];
    r.api = {
      mediaElementSetSinkId: typeof HTMLMediaElement.prototype.setSinkId,
      audioContextSetSinkId: typeof AudioContext.prototype.setSinkId,
      audioContextSinkId: 'sinkId' in AudioContext.prototype,
      audioContextOnSinkChange: 'onsinkchange' in AudioContext.prototype,
      selectAudioOutput: typeof navigator.mediaDevices.selectAudioOutput,
      ondevicechange: 'ondevicechange' in navigator.mediaDevices,
      audioWorklet: typeof AudioWorkletNode,
      scriptProcessor: typeof AudioContext.prototype.createScriptProcessor,
    };
    r.before = flat(sum(await T('enum-before', navigator.mediaDevices.enumerateDevices())));
    if (${fake}) {
      try {
        const s = await Promise.race([navigator.mediaDevices.getUserMedia({ audio: true }), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 6000))]);
        const t = s.getAudioTracks()[0];
        r.gum = { ok: true, settingsKeys: Object.keys(t.getSettings()), deviceIdIsSet: !!t.getSettings().deviceId, groupIdIsSet: !!t.getSettings().groupId };
        r.after = flat(sum(await navigator.mediaDevices.enumerateDevices()));
        const list = await navigator.mediaDevices.enumerateDevices();
        const ins = list.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
        if (ins[1]) {
          const s2 = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: ins[1].deviceId } } });
          r.gumExact = { sameAsAsked: s2.getAudioTracks()[0].getSettings().deviceId === ins[1].deviceId };
          s2.getTracks().forEach((x) => x.stop());
        }
        try { await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: 'nope' } } }); r.gumMissing = 'resolved'; }
        catch (e) { r.gumMissing = e.name + (e.constraint ? ':' + e.constraint : ''); }
        s.getTracks().forEach((x) => x.stop());
      } catch (e) { r.gum = { ok: false, error: String(e && e.name || e) }; }
    }
    const list = await T('enum-final', navigator.mediaDevices.enumerateDevices());
    const outs = list.filter((d) => d.kind === 'audiooutput');
    const target = outs.find((d) => d.deviceId && d.deviceId !== 'default') || outs[0];
    console.log('step ctx'); const ctx = new AudioContext();
    r.sink = { initial: typeof ctx.sinkId === 'string' ? (ctx.sinkId === '' ? '""' : 'id') : typeof ctx.sinkId };
    const tries = [['default', 'default'], ['none', { type: 'none' }], ['bogus', 'bogus-id']];
    if (target && target.deviceId) tries.unshift(['listed', target.deviceId]);
    for (const [name, v] of tries) {
      try { await T('sink-' + name, ctx.setSinkId(v)); r.sink[name] = 'ok:' + (typeof ctx.sinkId === 'string' ? (ctx.sinkId === '' ? '""' : ctx.sinkId === 'default' ? 'default' : 'id') : 'object'); }
      catch (e) { r.sink[name] = 'error:' + e.name; }
    }
    try { const c2 = new AudioContext({ sinkId: 'bogus-id' }); await new Promise((ok) => setTimeout(ok, 300)); r.sink.ctorBogus = 'made:' + c2.state; await T('c2close', c2.close()).catch(() => {}); }
    catch (e) { r.sink.ctorBogus = 'error:' + e.name; }
    const el = new Audio();
    try { await T('element', el.setSinkId(target ? target.deviceId : '')); r.sink.element = 'ok'; } catch (e) { r.sink.element = 'error:' + e.name; }
    await T('close', ctx.close()).catch(() => {});
    return r;
  })().catch((e) => ({ error: String(e && (e.stack || e)) }))`).catch((e) => ({ error: 'exec: ' + String(e) }));
  if (!out || out.error) { console.log(JSON.stringify(out)); app.exit(1); return; }
  out.electron = process.versions.electron; out.chrome = process.versions.chrome; out.mode = { fake, check };
  console.log(JSON.stringify(out));
  app.quit();
});
