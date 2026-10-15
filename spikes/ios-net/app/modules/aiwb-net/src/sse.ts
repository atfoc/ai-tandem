// Port of desktop/conn/sse.js EventReader: text in (already decoded by the native side, whole characters only), the data of each event
// out. Comment lines (the pings) and fields other than data are passed over.
export const MAX_STATE = 32 << 20;

export class TooLong extends Error {
  constructor() {
    super("the server's answer is too long");
    this.name = 'TooLong';
  }
}

export class EventReader {
  private buf = '';
  private data: string[] = [];
  private size = 0;
  constructor(private max = MAX_STATE) {}

  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
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
