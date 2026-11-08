// Side effect only: installs the page (page.ts) when evaluated. It is the first import of src/bin.ts, and of every test that
// uses the editor, so the DOM is on the global object before any tldraw module is evaluated in the process (ES modules are
// evaluated depth-first in import order: this module and its dependencies finish before the next import of the importer
// starts; rooms.ts → schema.ts imports tldraw statically).
import { installPage } from './page.ts'

installPage()
