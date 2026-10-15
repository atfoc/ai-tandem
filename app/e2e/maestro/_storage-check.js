// After `GET /device/storage?find=<the server's address>` (output.ctl): the app's data folder holds MMKV files, the search does read them (the address, which MMKV
// holds in the clear, is found in one), and the secret of the run is in none of the app's files.
if (!output.ctl.mmkv.length) throw new Error('no MMKV file in the app\'s data: ' + output.ctl.files + ' files');
if (FIND !== '' && !output.ctl.found.some(function (p) { return /mmkv/i.test(p); })) throw new Error('the search did not find ' + FIND + ' in an MMKV file: it found it in [' + output.ctl.found.join(', ') + ']');
if (output.ctl.hits.length) throw new Error('the secret is in: ' + output.ctl.hits.join(', '));
console.log('storage: ' + output.ctl.files + ' files, MMKV: ' + output.ctl.mmkv.map(function (f) { return f.path + ' (' + f.size + ' B)'; }).join(', ') + '; the address is in [' + output.ctl.found.join(', ') + ']; the secret is in none');
