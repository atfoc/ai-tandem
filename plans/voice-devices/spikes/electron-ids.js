'use strict';
// Spike (vd-architecture): are the desktop window's device ids the same from one run of the app to the next? Run twice and compare.
// Run: <electron binary> plans/voice-devices/spikes/electron-ids.js [fake]   (SPIKE_PAGE: a file:// page; SPIKE_USERDATA: the profile folder)
// With `fake`, prints the fake devices' labels and ids (they name nothing of this machine); without, only a digest of each real id (no names).
const { app, BrowserWindow } = require('electron');
const crypto = require('node:crypto');
const fake = process.argv.includes('fake');
if (fake) { app.commandLine.appendSwitch('use-fake-device-for-media-stream'); app.commandLine.appendSwitch('use-fake-ui-for-media-stream'); }
if (process.env.SPIKE_USERDATA) app.setPath('userData', process.env.SPIKE_USERDATA);
setTimeout(() => app.exit(2), 30000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadFile(process.env.SPIKE_PAGE);
  const list = await win.webContents.executeJavaScript('navigator.mediaDevices.enumerateDevices().then((l) => l.filter((d) => d.kind !== "videoinput").map((d) => ({ kind: d.kind, label: d.label, id: d.deviceId, group: d.groupId })))');
  const dig = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
  console.log(JSON.stringify(list.map((d) => fake ? d : { kind: d.kind, id: d.id === 'default' ? 'default' : dig(d.id), group: dig(d.group) })));
  app.quit();
});
