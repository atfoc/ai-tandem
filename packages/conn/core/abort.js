'use strict';

// abortError is what a call, a picture or an attempt rejects with when its signal aborted: an Error
// named AbortError, as the platform's own would be. It is made here and not by the platform so that
// the code of core/ runs where there is no DOMException (React Native's Hermes).
function abortError() {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

// isAbort says whether err is an AbortError, whoever made it.
const isAbort = (err) => !!err && err.name === 'AbortError';

module.exports = { abortError, isAbort };
