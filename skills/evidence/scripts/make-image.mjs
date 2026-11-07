// Usage: node make-image.mjs <file.png> <width>x<height>
// Writes a plain PNG of that size (a light fill with a dark band, so a scaled copy still shows its edges), for a case
// that uploads a generic image. An input whose origin matters (a camera photo) comes from Fixtures:, never from here.
import { writeFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

export function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = 1 + width * 3;
  const pixels = Buffer.alloc(row * height, 0xe0);
  for (let y = 0; y < height; y++) {
    pixels[y * row] = 0; // filter: none
    if (y >= height / 3 && y < (2 * height) / 3) pixels.fill(0x30, y * row + 1, (y + 1) * row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [file, size] = process.argv.slice(2);
  const [, w, h] = String(size).match(/^(\d+)x(\d+)$/) ?? [];
  if (!file?.endsWith('.png') || !w || +w < 1 || +h < 1 || +w * +h > 25e6) {
    console.error('Usage: node make-image.mjs <file.png> <width>x<height> (at most 25 million pixels)');
    process.exit(1);
  }
  writeFileSync(file, png(+w, +h));
  console.log(`Wrote ${file}: ${w}x${h} PNG`);
}
