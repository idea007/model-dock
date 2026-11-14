import { crc32 } from 'node:zlib';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpegFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 3 < bytes.length && bytes[offset] === 0xff) {
    // JPEG permits fill bytes between segments.
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) return;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return;
    if (jpegFrameMarkers.has(marker)) {
      if (length < 8) return;
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
}

function pngDimensions(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(pngSignature) && bytes.readUInt32BE(8) === 13 && bytes.toString('latin1', 12, 16) === 'IHDR') {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
}

function webpDimensions(bytes) {
  if (bytes.length < 20 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return;
  const end = 8 + bytes.readUInt32LE(4);
  const length = bytes.readUInt32LE(16);
  if (end > bytes.length || 20 + length + (length % 2) > end) return;
  const chunk = bytes.toString('latin1', 12, 16);
  if (chunk === 'VP8X' && length === 10) {
    return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
  }
  if (chunk === 'VP8L' && length >= 5 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
  }
  if (chunk === 'VP8 ' && length >= 10 && bytes.readUIntLE(23, 3) === 0x2a019d) {
    return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
  }
}

export function imageInfo(bytes) {
  let format, dimensions;
  if (bytes.subarray(0, 8).equals(pngSignature)) {
    format = 'png';
    dimensions = pngDimensions(bytes);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    format = 'jpeg';
    dimensions = jpegDimensions(bytes);
  } else {
    format = 'webp';
    dimensions = webpDimensions(bytes);
  }
  const [width, height] = dimensions || [];
  if (width && height) return { format, width, height };
}

function hasValidPngChunks(bytes) {
  let offset = pngSignature.length, hasData = false;
  while (offset + 12 <= bytes.length) {
    const end = offset + 8 + bytes.readUInt32BE(offset);
    if (end + 4 > bytes.length || crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) return false;
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT' && end > offset + 8) hasData = true;
    if (type === 'IEND') return hasData && end === offset + 8 && end + 4 === bytes.length;
    offset = end + 4;
  }
  return false;
}

function hasWebpImageData(bytes) {
  if (8 + bytes.readUInt32LE(4) !== bytes.length) return false;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length + length % 2;
    if (end > bytes.length) return false;
    const type = bytes.toString('latin1', offset, offset + 4);
    if (type === 'VP8 ') return length > 10 && bytes.readUIntLE(offset + 11, 3) === 0x2a019d;
    if (type === 'VP8L') return length > 5 && bytes[offset + 8] === 0x2f;
    if (type === 'ANMF') return length > 24;
    offset = end;
  }
  return false;
}

const imageInputChecks = {
  png: hasValidPngChunks,
  jpeg: bytes => bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9,
  webp: hasWebpImageData
};

export function parseImageDataUrl(value) {
  const header = typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,/i.exec(value);
  if (header) return { encoded: value.slice(header[0].length), format: header[1].toLowerCase() };
}

export function imageDataByteLength(encoded) {
  if (encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}(?![\s\S])/u.test(encoded)) return;
  return Buffer.byteLength(encoded, 'base64');
}

export function decodeImageData(encoded, format, { checkContainer = false } = {}) {
  const bytes = Buffer.from(encoded, 'base64');
  if (imageInfo(bytes)?.format === format && (!checkContainer || imageInputChecks[format](bytes))) return { bytes, format };
}
