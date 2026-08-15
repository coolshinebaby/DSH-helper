const fs = require('node:fs');
const path = require('node:path');

function pixel(size, x, y) {
  const bg = [17, 19, 24, 255];
  const sx = size / 32; const px = x / sx; const py = y / sx;
  const body = ((px - 15) ** 2) / 105 + ((py - 16) ** 2) / 42 < 1 && px > 5 && px < 28;
  const tail = px < 10 && py > 14 && py < 23;
  const fin = px > 22 && py > 8 && py < 15;
  const whale = body || tail || fin;
  if (!whale) return bg;
  const eye = (px - 21) ** 2 + (py - 12) ** 2 < 1.2;
  const wave = Math.abs(py - (18 + Math.sin((px - 8) / 3) * 1.2)) < .8 && px > 8 && px < 24;
  return eye || wave ? bg : [255, 255, 255, 255];
}
function dib(size) {
  const rowBytes = size * 4;
  const pixels = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const [r, g, b, a] = pixel(size, x, y);
    const offset = ((size - y - 1) * size + x) * 4;
    pixels[offset] = b; pixels[offset + 1] = g; pixels[offset + 2] = r; pixels[offset + 3] = a;
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14); header.writeUInt32LE(0, 16); header.writeUInt32LE(pixels.length + mask.length, 20);
  return Buffer.concat([header, pixels, mask]);
}
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, data: dib(size) }));
const header = Buffer.alloc(6 + images.length * 16); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ size, data }, index) => { const entry = 6 + index * 16; header.writeUInt8(size === 256 ? 0 : size, entry); header.writeUInt8(size === 256 ? 0 : size, entry + 1); header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6); header.writeUInt32LE(data.length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += data.length; });
fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([header, ...images.map((image) => image.data)]));
