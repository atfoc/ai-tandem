'use strict';

// The event stream's reader: text in (the Session decodes the bytes), the data of each event out.
// Comment lines (the pings among them) and fields other than data are passed over (port of
// readEvent in internal/servers/conn.go). The limit counts characters.

const { MAX_STATE } = require('./text');

class TooLong extends Error {
  constructor() {
    super("the server's answer is too long");
    this.name = 'TooLong';
  }
}

class EventReader {
  constructor(max = MAX_STATE) {
    this.max = max;
    this.buf = '';
    this.data = [];
    this.size = 0;
  }

  // push takes a chunk of text and returns the data of the events it completed, in order. It
  // throws TooLong for an event of more than the limit.
  push(text) {
    this.buf += text;
    const out = [];
    let pos = 0;
    for (;;) {
      const nl = this.buf.indexOf('\n', pos);
      if (nl < 0) break;
      let line = this.buf.slice(pos, nl);
      pos = nl + 1;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (this.data.length) {
          out.push(this.data.join('\n'));
          this.data = [];
          this.size = 0;
        }
      } else if (line.startsWith('data:')) {
        let v = line.slice(5);
        if (v.startsWith(' ')) v = v.slice(1);
        this.size += v.length + 1;
        if (this.size > this.max) throw new TooLong();
        this.data.push(v);
      }
    }
    this.buf = this.buf.slice(pos);
    if (this.buf.length + this.size > this.max) throw new TooLong();
    return out;
  }
}

module.exports = { EventReader, TooLong };
