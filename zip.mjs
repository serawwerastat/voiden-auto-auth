#!/usr/bin/env node
/**
 * Packages the built plugin for "Extensions → ⋯ → Install from file":
 * dist/<id>.zip containing <id>.js, manifest.json and changelog.json (plus
 * <id>-main.cjs when the plugin has a main-process part).
 *
 * Pure Node (zlib) so it works the same on Windows, macOS and Linux.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const id = manifest.id;

const files = [
  [`${id}.js`, `dist/${id}.js`],
  ["manifest.json", "manifest.json"],
  ["changelog.json", "changelog.json"],
  [`${id}-main.cjs`, `dist/${id}-main.cjs`],
].filter(([name, path]) => {
  if (existsSync(path)) return true;
  if (name === `${id}.js`) {
    console.error(`dist/${id}.js not found — run "npm run build" first.`);
    process.exit(1);
  }
  return false;
});

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

const locals = [];
const centrals = [];
let offset = 0;

for (const [name, path] of files) {
  const data = readFileSync(path);
  const packed = deflateRawSync(data);
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  locals.push(local, nameBuf, packed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory header
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBuf);

  offset += local.length + nameBuf.length + packed.length;
}

const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); // end of central directory
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const out = `dist/${id}.zip`;
writeFileSync(out, Buffer.concat([...locals, ...centrals, end]));
console.log(`${out}  (${files.map(([n]) => n).join(", ")})`);
console.log(`Install: Voiden → Extensions → ⋯ → Install from file → ${out}`);
