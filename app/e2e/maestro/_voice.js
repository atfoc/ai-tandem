// A call of the stand-in voice service's control (app/e2e/lib/voice.mjs, `needs=voice`): `runScript` with env { ROUTE, BODY } (BODY is JSON text).
// Fails the flow when the call does.
var r = http.post(VOICE_CONTROL + ROUTE, { headers: { 'Content-Type': 'application/json' }, body: BODY });
if (!r.ok) throw new Error('voice control ' + ROUTE + ' failed: ' + r.status + ' ' + r.body);
