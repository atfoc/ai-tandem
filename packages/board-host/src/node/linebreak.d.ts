// The part of the `linebreak` package (1.1.0, UAX #14) measure.ts uses; the package ships no types.
declare module 'linebreak' {
  export default class LineBreaker {
    constructor(text: string)
    /** The next break opportunity, or null at the end of the text. */
    nextBreak(): { position: number; required: boolean } | null
  }
}
