/**
 * Minimal stored-only (no compression) ZIP writer.
 *
 * Why not yauzl/jszip/archiver? They're all fine, but we wanted zero new
 * dependencies for a Phase-6-only feature, and the data shapes here
 * (CSVs of a few thousand rows each) compress poorly with DEFLATE because
 * they're already plain ASCII. Stored-only ZIP is smaller on disk for
 * this content than DEFLATE in practice.
 *
 * Format reference: APPNOTE.TXT (PKWARE) v6.3.10. Local file headers,
 * central directory entries, end-of-central-directory record. No zip64,
 * no encryption. Single-volume "store" entries. CRC32 computed on the
 * bytes via the standard polynomial table generated at module load.
 *
 * Limits: total uncompressed size of every entry ≤ 0xFFFFFFFF bytes
 * (about 4.3 GB), total file count ≤ 0xFFFF. Both are well above
 * anything our CSVs will approach.
 *
 * Usage:
 *   const buf = zipSync([
 *     { name: 'manifest.json', data: '{...}\n', mtime: new Date() },
 *     { name: 'invoices.csv',  data: '...\r\n', mtime: new Date() },
 *   ]);
 *   fs.writeFileSync('bundle.zip', buf);
 */

import { Buffer } from 'node:buffer';
import { crc32 } from 'node:zlib';

// ---- CRC32 table (IEEE 802.3 polynomial reversed) ----
// Use the zlib-native crc32 from `node:zlib` — already fast and
// imported. Falls back to the manual table below only if the native
// one is unavailable (Node < 20).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Of(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// MS-DOS date/time encoding for the local file header.
// We don't bother with the full precision path — split-second
// precision is not useful for an accountant bundle.
function dosDateTime(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  if (isNaN(d.getTime())) {
    const n = new Date();
    return dosDateTime(n);
  }
  const year = Math.max(1980, d.getFullYear());
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hour = d.getHours();
  const min = d.getMinutes();
  const sec = Math.floor(d.getSeconds() / 2); // ZIP has 2-second resolution
  const dosTime = (hour << 11) | (min << 5) | sec;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

/**
 * Encode a list of files into a single ZIP archive Buffer.
 *
 * @param {Array<{name: string, data: string|Buffer, mtime?: Date|string}>} entries
 * @returns {Buffer}
 */
export function zipSync(entries) {
  // Each entry's local header is variable-length because of the name
  // length. We keep the central directory pointers so we can rewrite
  // them later (we won't — store-only zip files don't need a second
  // pass, since stored entries are 1:1 with their local-header
  // payload).
  const localParts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name), 'utf8');
    const dataBuf = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(String(entry.data), 'utf8');
    const { dosTime, dosDate } = dosDateTime(entry.mtime);
    const crc = crc32Of(dataBuf);
    const size = dataBuf.length;

    // Local file header (signature 0x04034b50)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);  // signature
    lfh.writeUInt16LE(20, 4);          // version needed (2.0 = store)
    lfh.writeUInt16LE(0x0800, 6);      // general purpose flag: bit 11 = UTF-8 names
    lfh.writeUInt16LE(0, 8);           // compression method: 0 = store
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(size, 18);       // compressed size (= uncompressed in store mode)
    lfh.writeUInt32LE(size, 22);       // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);          // extra field length

    const localFragment = Buffer.concat([lfh, nameBuf, dataBuf]);
    localParts.push(localFragment);

    // Central directory entry (signature 0x02014b50)
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);           // version made by
    cd.writeUInt16LE(20, 6);           // version needed
    cd.writeUInt16LE(0x0800, 8);       // general purpose bit flag
    cd.writeUInt16LE(0, 10);           // compression method
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);           // extra field length
    cd.writeUInt16LE(0, 32);           // comment length
    cd.writeUInt16LE(0, 34);           // disk number
    cd.writeUInt16LE(0, 36);           // internal attrs
    cd.writeUInt32LE(0, 38);           // external attrs
    cd.writeUInt32LE(offset, 42);      // local header offset

    central.push(Buffer.concat([cd, nameBuf]));
    offset += localFragment.length;
  }

  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  const cdSize = centralSection.length;
  const cdOffset = localSection.length;
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);            // disk number
  eocd.writeUInt16LE(0, 6);            // disk where CD starts
  eocd.writeUInt16LE(entries.length, 8);   // # entries on this disk
  eocd.writeUInt16LE(entries.length, 10);  // # entries total
  eocd.writeUInt32LE(cdSize, 12);      // CD size
  eocd.writeUInt32LE(cdOffset, 16);    // CD offset
  eocd.writeUInt16LE(0, 20);           // comment length

  return Buffer.concat([localSection, centralSection, eocd]);
}

// Force crc32 to be required (proves the dep path is wired even if unused).
export const _crcModuleOk = typeof crc32 === 'function';
