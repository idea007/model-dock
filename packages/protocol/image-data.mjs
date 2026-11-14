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

function webpDimensions(bytes) {
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
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(pngSignature) && bytes.readUInt32BE(8) === 13 && bytes.toString('latin1', 12, 16) === 'IHDR') {
    format = 'png';
    dimensions = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    format = 'jpeg';
    dimensions = jpegDimensions(bytes);
  } else if (bytes.length >= 20 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    format = 'webp';
    dimensions = webpDimensions(bytes);
  }
  const [width, height] = dimensions || [];
  if (width && height) return { format, width, height };
}
