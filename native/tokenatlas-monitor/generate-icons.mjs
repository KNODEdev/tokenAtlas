// Render the approved favicon without changing its geometry or palette.
import { readFile, writeFile } from 'node:fs/promises';
const { default: sharp } = await import(process.env.TOKENATLAS_SHARP_MODULE || 'sharp');
const source = await readFile(new URL('../../src/web/favicon.svg', import.meta.url));
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024];
const images = new Map();
for (const size of sizes) images.set(size, await sharp(source, { density: 2048 }).resize(size, size).png().toBuffer());
const assets = new URL('./assets/', import.meta.url);
await writeFile(new URL('tokenatlas-monitor.png', assets), images.get(256));
const frames = sizes.filter(size => size <= 256);
const header = Buffer.alloc(6 + frames.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach((size, index) => {
  const at = 6 + index * 16, png = images.get(size);
  header[at] = size === 256 ? 0 : size; header[at + 1] = header[at];
  header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12);
  offset += png.length;
});
await writeFile(new URL('tokenatlas-monitor.ico', assets), Buffer.concat([header, ...frames.map(size => images.get(size))]));
const types = ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10'];
const chunks = [16, 32, 64, 128, 256, 512, 1024].map((size, index) => {
  const png = images.get(size), chunk = Buffer.alloc(8);
  chunk.write(types[index]); chunk.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([chunk, png]);
});
const icns = Buffer.alloc(8); icns.write('icns');
icns.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
await writeFile(new URL('tokenatlas-monitor.icns', assets), Buffer.concat([icns, ...chunks]));
