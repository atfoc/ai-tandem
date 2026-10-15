// The matching of typed search terms, shared by the model picker (models.ts) and the prompt
// search (promptsearch.ts): a search is split at whitespace into terms, and a text holds them
// when each is in it as a substring, in the typed order, one after the other and without overlap.
// DOM-free.

/** The terms of a typed search, lowercased; none for an empty or whitespace-only search. */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((t) => t);
}

/** How many of the leading terms the text holds, each found after the end of the one before.
 *  The text and the terms are lowercased by the caller. */
export function leadingTerms(text: string, terms: string[]): number {
  let cursor = 0;
  for (let i = 0; i < terms.length; i++) {
    const at = text.indexOf(terms[i], cursor);
    if (at < 0) return i;
    cursor = at + terms[i].length;
  }
  return terms.length;
}

/** True when the text holds every term in order and without overlap; no terms match any text. */
export function hasTerms(text: string, terms: string[]): boolean {
  return leadingTerms(text, terms) === terms.length;
}
