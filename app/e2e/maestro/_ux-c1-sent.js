// `ux-composer`: the user's messages of the chat CHAT on the server (control API GET /sent) are N in number; when LINES is given ("line one|two": the lines
// separated by "|"), the last one is those lines joined by line breaks, and nothing else (KEEPSTART "1": its leading white space counts too). The answer is in
// `output.sent`.
var r = http.get(CONTROL_URL + '/sent?chat=' + CHAT);
if (!r.ok) throw new Error('control GET /sent failed: ' + r.status + ' ' + r.body);
var sent = json(r.body).sent;
output.sent = sent;
if (sent.length !== Number(N)) throw new Error('the server holds ' + sent.length + ' messages of the user, expected ' + N + ': ' + JSON.stringify(sent));
if (typeof LINES === 'string' && LINES !== '') {
  var want = LINES.split('|').join('\n');
  var last = String(sent[sent.length - 1]);
  var got = typeof KEEPSTART === 'string' && KEEPSTART === '1' ? last.replace(/\s+$/, '') : last.trim();
  if (got !== want) throw new Error('the last message is ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want));
}
console.log('the server holds ' + sent.length + ' message(s): ' + JSON.stringify(sent));
