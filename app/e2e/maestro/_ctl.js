// A call of the control API of the runner (app/e2e/lib/serverctl.mjs): `runScript` with env { METHOD, ROUTE }. Fails the flow when the
// call does; the answer is in `output.ctl`.
var r = METHOD == 'GET' ? http.get(CONTROL_URL + ROUTE) : http.post(CONTROL_URL + ROUTE, { headers: { 'Content-Type': 'application/json' }, body: '{}' });
if (!r.ok) throw new Error('control ' + METHOD + ' ' + ROUTE + ' failed: ' + r.status + ' ' + r.body);
output.ctl = json(r.body);
