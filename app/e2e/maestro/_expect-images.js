// After `GET /chat-images` (output.ctl): the images the server holds are exactly those of EXPECT, "type WxH;type WxH;...", whatever the order: what the
// phone sent is what the person picked (a PNG stays a PNG, a HEIC arrives as a JPEG of its size), each as the type its bytes have.
var got = output.ctl.images.map(function (i) {
  if (i.type !== i.bytesType) throw new Error(i.name + ': the server says ' + i.type + ' but the bytes are ' + i.bytesType);
  if (i.got !== i.size) throw new Error(i.name + ': ' + i.size + ' bytes announced, ' + i.got + ' fetched');
  return i.type + ' ' + i.width + 'x' + i.height;
}).sort();
var want = EXPECT.split(';').sort();
if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error('the server holds ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want));
console.log('the server received: ' + got.join(', ') + ' (' + output.ctl.images.map(function (i) { return i.name; }).join(', ') + ')');
