// Reads the chip input's latest state from the runner's control API (GET /box) and tells whether the chip is the whole selection: `output.chipSelected`.
var r = http.get(CONTROL_URL + '/box');
if (!r.ok) throw new Error('control GET /box failed: ' + r.status + ' ' + r.body);
var b = json(r.body).box;
output.chipSelected = !!(b && b.chips.length == 1 && b.selection.start == b.chips[0][0] && b.selection.end == b.chips[0][1]);
