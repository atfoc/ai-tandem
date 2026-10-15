'use strict';

// memoryStore is a Store (ports.d.ts) in memory, as a phone's would be in its storage. It keeps
// what it was given to see: `saved` (the list as last written, a copy), `writes`, `asides` (the
// reasons the list was put aside). `saved` may be an Error: read() then throws it.

const CLIENT_ID = '00000000-0000-4000-8000-000000000000';

function memoryStore(saved = null, { clientId = CLIENT_ID } = {}) {
  const s = {
    where: "the app's storage",
    saved,
    writes: 0,
    asides: [],
    read() { if (s.saved instanceof Error) throw s.saved; return s.saved; },
    write(list) { s.writes++; s.saved = JSON.parse(JSON.stringify(list)); },
    setAside(why) { s.asides.push(why); s.saved = null; return 'list.unreadable-1'; },
    clientId: () => clientId,
  };
  return s;
}

module.exports = { memoryStore, CLIENT_ID };
