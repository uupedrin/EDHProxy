// Minimal ZIP reader for the release archive: stored and deflate entries, no zip64/encryption.
// Returns [{ path, data: Uint8Array }] for files (directory entries are skipped).
// eslint-disable-next-line no-unused-vars
async function unzip(buffer) {
  'use strict';
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // End of central directory: last 22+ bytes, signature 0x06054b50.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);

  const files = [];
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip (central directory)');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const path = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;

    if (path.endsWith('/')) continue;
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('unsafe path in zip: ' + path);
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error('corrupt zip (local header)');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + compSize);

    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error(`unsupported compression method ${method} for ${path}`);
    files.push({ path, data });
  }
  return files;
}
