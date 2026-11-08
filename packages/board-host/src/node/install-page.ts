// Side effect only: installs the page (page.ts) when evaluated. It is the first import of src/bin.ts, and of every test that
// uses the editor, so the DOM is on the global object before any tldraw module is evaluated in the process (ES modules are
// evaluated depth-first in import order: this module and its dependencies finish before the next import of the importer
// starts; rooms.ts → schema.ts imports tldraw statically).
import { installPage } from './page.ts'

// The process cannot start without its page (AIWB_BOARDHOST_DOM names an unknown DOM, or jsdom when it is not installed): the
// reason on stderr and the start-up failure code (main.ts EXIT_START_FAILED, not imported: main.ts brings tldraw), not a stack.
try {
  installPage()
} catch (e) {
  process.stderr.write(`cannot start the board host: ${(e as Error)?.message ?? String(e)}\n`)
  process.exit(3)
}
