const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  IMAGE_MAX_BYTES,
  IMAGES_PER_MESSAGE,
  IMAGE_TYPES,
  imageType,
  fromAppWindow,
  pickImages,
} = require('../lib');

const pageURL = 'file:///Applications/AI%20Whiteboard.app/Contents/Resources/web/index.html';

// tmpDir makes a folder for the test's files, removed when the test ends.
async function tmpDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiwb-pick-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

// write makes the file dir/name with the given bytes (a Buffer, or a size to fill) and returns its
// path.
async function write(dir, name, bytes) {
  const file = path.join(dir, name);
  await fsp.writeFile(file, typeof bytes === 'number' ? Buffer.alloc(bytes, 7) : bytes);
  return file;
}

// fakes builds the app's main window, an IPC event from its main frame, a dialog that answers
// `answer` and records how it was opened, and an fs that is the real one but records every path
// opened and every byte count read. onDialog runs while the dialog is open.
function fakes({ answer = { canceled: true, filePaths: [] }, onDialog } = {}) {
  const mainFrame = { url: pageURL };
  const webContents = { mainFrame };
  const win = { webContents, destroyed: false, isDestroyed: () => win.destroyed };
  const event = { sender: webContents, senderFrame: mainFrame };
  const dialog = {
    shown: [],
    async showOpenDialog(parent, opts) {
      dialog.shown.push({ parent, opts });
      if (onDialog) onDialog(f);
      return answer;
    },
  };
  const fs = {
    opened: [],
    bytesRead: 0,
    async open(file, flags) {
      fs.opened.push(file);
      const handle = await fsp.open(file, flags);
      return {
        stat: () => handle.stat(),
        close: () => handle.close(),
        async read(...args) {
          const res = await handle.read(...args);
          fs.bytesRead += res.bytesRead;
          return res;
        },
      };
    },
  };
  const f = { win, webContents, mainFrame, event, dialog, fs };
  return f;
}

const pick = (f, more = {}) =>
  pickImages({ event: f.event, win: f.win, pageURL, dialog: f.dialog, fs: f.fs, ...more });

test('the limits and types are the server\'s', () => {
  assert.equal(IMAGE_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(IMAGES_PER_MESSAGE, 10);
  assert.deepEqual([...new Set(Object.values(IMAGE_TYPES))].sort(),
    ['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
});

test('imageType: by extension, whatever its case; null for anything else', () => {
  assert.equal(imageType('a.png'), 'image/png');
  assert.equal(imageType('a.jpg'), 'image/jpeg');
  assert.equal(imageType('a.JPEG'), 'image/jpeg');
  assert.equal(imageType('a.Gif'), 'image/gif');
  assert.equal(imageType('a.b.webp'), 'image/webp');
  for (const name of ['a.svg', 'a.txt', 'a.png.html', 'png', '.png', 'a', 'a.', 'a.constructor']) {
    assert.equal(imageType(name), null, name);
  }
});

test('what the dialog returns: each file\'s base name, type and bytes, in the dialog\'s order', async (t) => {
  const dir = await tmpDir(t);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 9]);
  const filePaths = [
    await write(dir, 'shot one.PNG', png),
    await write(dir, 'photo.jpeg', jpg),
    await write(dir, 'anim.gif', Buffer.from('GIF89a')),
    await write(dir, 'pic.webp', Buffer.from('RIFF')),
    await write(dir, 'empty.jpg', Buffer.alloc(0)),
  ];
  const f = fakes({ answer: { canceled: false, filePaths } });
  const res = await pick(f);

  assert.deepEqual(res.skipped, []);
  assert.deepEqual(res.files.map(({ name, type }) => ({ name, type })), [
    { name: 'shot one.PNG', type: 'image/png' },
    { name: 'photo.jpeg', type: 'image/jpeg' },
    { name: 'anim.gif', type: 'image/gif' },
    { name: 'pic.webp', type: 'image/webp' },
    { name: 'empty.jpg', type: 'image/jpeg' },
  ]);
  for (const file of res.files) {
    // A plain Uint8Array on a buffer of exactly its bytes, and no other key (no path).
    assert.equal(Object.getPrototypeOf(file.data), Uint8Array.prototype, file.name);
    assert.equal(file.data.buffer.byteLength, file.data.length, file.name);
    assert.deepEqual(Object.keys(file), ['name', 'type', 'data']);
  }
  assert.deepEqual(Buffer.from(res.files[0].data), png);
  assert.deepEqual(Buffer.from(res.files[1].data), jpg);
  assert.equal(res.files[4].data.length, 0);
  assert.deepEqual(f.fs.opened, filePaths);
});

test('the dialog is the app\'s open dialog on the main window, for several image files', async () => {
  const f = fakes();
  await pick(f);
  assert.equal(f.dialog.shown.length, 1);
  const { parent, opts } = f.dialog.shown[0];
  assert.equal(parent, f.win);
  assert.deepEqual(opts.properties, ['openFile', 'multiSelections']);
  assert.deepEqual(opts.filters, [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]);
});

test('a cancelled dialog: both lists empty, nothing opened', async (t) => {
  const dir = await tmpDir(t);
  const file = await write(dir, 'a.png', 3);
  for (const answer of [
    { canceled: true, filePaths: [] },
    { canceled: true, filePaths: [file] },
    { canceled: false, filePaths: [] },
  ]) {
    const f = fakes({ answer });
    assert.deepEqual(await pick(f), { files: [], skipped: [] });
    assert.deepEqual(f.fs.opened, []);
  }
});

test('a file over the size limit is left out as "size" and none of it is read', async (t) => {
  const dir = await tmpDir(t);
  const filePaths = [
    await write(dir, 'at-limit.png', IMAGE_MAX_BYTES),
    await write(dir, 'over.png', IMAGE_MAX_BYTES + 1),
    await write(dir, 'small.gif', 10),
  ];
  const f = fakes({ answer: { canceled: false, filePaths } });
  const res = await pick(f);
  assert.deepEqual(res.files.map((x) => [x.name, x.data.length]),
    [['at-limit.png', IMAGE_MAX_BYTES], ['small.gif', 10]]);
  assert.deepEqual(res.skipped, [{ name: 'over.png', reason: 'size' }]);
  assert.equal(f.fs.bytesRead, IMAGE_MAX_BYTES + 10);
});

test('a file that grew past the limit after its size was seen: "size", at most one byte over is read', async () => {
  const f = fakes({ answer: { canceled: false, filePaths: ['/pics/growing.png'] } });
  let read = 0;
  let closed = 0;
  f.fs = {
    async open() {
      return {
        stat: async () => ({ isFile: () => true, size: 4 }),
        async read(buf, offset, length) {
          buf.fill(1, offset, offset + length); // never ends
          read += length;
          return { bytesRead: length };
        },
        close: async () => { closed++; },
      };
    },
  };
  const res = await pick(f, { maxBytes: 100 });
  assert.deepEqual(res, { files: [], skipped: [{ name: 'growing.png', reason: 'size' }] });
  assert.equal(read, 101);
  assert.equal(closed, 1);
});

test('more files than the count limit: the first ten are read, the rest left out as "count" unopened', async (t) => {
  const dir = await tmpDir(t);
  const filePaths = [];
  for (let i = 0; i < IMAGES_PER_MESSAGE + 3; i++) {
    filePaths.push(await write(dir, `p${i}.png`, Buffer.from([i])));
  }
  const f = fakes({ answer: { canceled: false, filePaths } });
  const res = await pick(f);
  assert.deepEqual(res.files.map((x) => x.name), filePaths.slice(0, 10).map((p) => path.basename(p)));
  assert.deepEqual(res.files.map((x) => x.data[0]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(res.skipped, [
    { name: 'p10.png', reason: 'count' },
    { name: 'p11.png', reason: 'count' },
    { name: 'p12.png', reason: 'count' },
  ]);
  assert.deepEqual(f.fs.opened, filePaths.slice(0, 10));
});

test('a file left out for its size, type or a failed read takes no place of the count', async (t) => {
  const dir = await tmpDir(t);
  const filePaths = [
    await write(dir, 'big.png', 9),
    await write(dir, 'notes.txt', 1),
    path.join(dir, 'gone.png'),
    await write(dir, 'a.png', 1),
    await write(dir, 'b.png', 2),
    await write(dir, 'c.png', 3),
    await write(dir, 'late.svg', 1),
  ];
  const f = fakes({ answer: { canceled: false, filePaths } });
  const res = await pick(f, { maxBytes: 8, maxFiles: 2 });
  assert.deepEqual(res.files.map((x) => x.name), ['a.png', 'b.png']);
  assert.deepEqual(res.skipped, [
    { name: 'big.png', reason: 'size' },
    { name: 'notes.txt', reason: 'type' },
    { name: 'gone.png', reason: 'read' },
    { name: 'c.png', reason: 'count' },
    { name: 'late.svg', reason: 'type' },
  ]);
});

test('a file of another type is left out as "type" and never opened', async (t) => {
  const dir = await tmpDir(t);
  const filePaths = [
    await write(dir, 'drawing.svg', '<svg/>'),
    await write(dir, 'page.png.html', '<html>'),
    await write(dir, 'noext', 'x'),
    await write(dir, 'ok.webp', 'x'),
  ];
  const f = fakes({ answer: { canceled: false, filePaths } });
  const res = await pick(f);
  assert.deepEqual(res.files.map((x) => x.name), ['ok.webp']);
  assert.deepEqual(res.skipped, [
    { name: 'drawing.svg', reason: 'type' },
    { name: 'page.png.html', reason: 'type' },
    { name: 'noext', reason: 'type' },
  ]);
  assert.deepEqual(f.fs.opened, [filePaths[3]]);
});

test('a file that cannot be read, or is no file, is left out as "read"', async (t) => {
  const dir = await tmpDir(t);
  const folder = path.join(dir, 'folder.png');
  await fsp.mkdir(folder);
  const filePaths = [path.join(dir, 'missing.png'), folder, await write(dir, 'ok.png', 2)];
  const f = fakes({ answer: { canceled: false, filePaths } });
  const res = await pick(f);
  assert.deepEqual(res.files.map((x) => x.name), ['ok.png']);
  assert.deepEqual(res.skipped, [
    { name: 'missing.png', reason: 'read' },
    { name: 'folder.png', reason: 'read' },
  ]);
});

// Each entry changes the fakes so that the caller is not the app window's main frame on the page.
const notTheAppWindow = {
  'another window': (f) => {
    f.event.sender = { mainFrame: f.event.senderFrame };
  },
  'a frame inside the page': (f) => {
    f.event.senderFrame = { url: pageURL, parent: f.mainFrame };
  },
  'the main frame on another page': (f) => {
    f.mainFrame.url = 'file:///tmp/other.html';
  },
  'the main frame on a site': (f) => {
    f.mainFrame.url = 'https://example.com/';
  },
  'a page with no URL (about:blank)': (f) => {
    f.mainFrame.url = 'about:blank';
  },
  'a frame that is gone': (f) => {
    f.event.senderFrame = null;
  },
  'a closed main window': (f) => {
    f.win.destroyed = true;
  },
};

for (const [name, change] of Object.entries(notTheAppWindow)) {
  test(`a caller that is not the app's own window (${name}): refused, no dialog, nothing read`, async (t) => {
    const dir = await tmpDir(t);
    const f = fakes({ answer: { canceled: false, filePaths: [await write(dir, 'a.png', 3)] } });
    assert.equal(fromAppWindow({ event: f.event, win: f.win, pageURL }), true);
    change(f);
    assert.equal(fromAppWindow({ event: f.event, win: f.win, pageURL }), false);
    await assert.rejects(pick(f), /not from the app window/);
    assert.deepEqual(f.dialog.shown, []);
    assert.deepEqual(f.fs.opened, []);
  });

  test(`the caller stops being the app's own window while the dialog is open (${name}): refused, nothing read`, async (t) => {
    const dir = await tmpDir(t);
    const f = fakes({
      answer: { canceled: false, filePaths: [await write(dir, 'a.png', 3)] },
      onDialog: change,
    });
    await assert.rejects(pick(f), /not from the app window/);
    assert.equal(f.dialog.shown.length, 1);
    assert.deepEqual(f.fs.opened, []);
  });
}

test('the page with a hash is still the page', () => {
  const f = fakes();
  f.mainFrame.url = `${pageURL}#/chat/c_1`;
  assert.equal(fromAppWindow({ event: f.event, win: f.win, pageURL }), true);
});

test('no main window, or no page URL: refused, no dialog', async () => {
  for (const over of [{ win: null }, { pageURL: null }, { pageURL: 'not a url' }]) {
    const f = fakes();
    await assert.rejects(pick(f, over), /not from the app window/, JSON.stringify(over));
    assert.deepEqual(f.dialog.shown, []);
  }
});

// main.js needs Electron and starts the app when it is loaded, so its one use of the dialog is read
// as text: the face hands pickImages the caller's event, the app's main window and the page's URL,
// and nothing a page sent with its call.
test('ipcface: the dialog is answered through pickImages, with the main window, the page URL and no argument of the page', async () => {
  const src = await fsp.readFile(path.join(__dirname, '..', 'ipcface.js'), 'utf8');
  const handlers = src.split("ipcMain.handle('aiwb:pick-images',");
  assert.equal(handlers.length, 2);
  assert.match(handlers[1].split(');')[0], /pickImages\(\{ event, win: getWindow\(\), pageURL, dialog \}\)/);
  assert.equal(src.split('dialog.showOpenDialog').length, 1); // no other open dialog than pickImages' own
});
