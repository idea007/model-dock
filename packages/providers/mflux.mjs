import { GatewayError, fail } from '../protocol/index.mjs';
import { decodeImageData, imageDataByteLength, imageInfo } from '../protocol/image-data.mjs';
import { fetchUpstream, headers, jsonResponse, protocolError } from './http.mjs';

const MiB = 1024 * 1024;
const maxReferenceBytes = 10 * MiB;
const maxRequestBytes = 15 * MiB;
const maxResultBytes = 16 * MiB;
const ratioSizes = { '1:1': '1024x1024', '16:9': '1024x576', '4:5': '768x960' };
const sizePattern = /^([1-9][0-9]{0,3})x([1-9][0-9]{0,3})$/;

export const mflux = {
  async discover(connection, { secret, signal }) {
    const response = await fetchUpstream(`${connection.baseUrl}/models`, { headers: headers(secret), signal });
    const body = await jsonResponse(response, 256 * 1024);
    if (body?.provider !== 'local-mflux' || body.protocolVersion !== 2 || body.status !== 'ready' || !Array.isArray(body.data)) {
      throw protocolError();
    }
    return body.data.filter(item => item?.status === 'ready').map(item => {
      if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(item.id)
        || typeof item.revision !== 'string' || !/^[a-f0-9]{40}$/.test(item.revision)
        || !Array.isArray(item.sizes) || !item.sizes.length || !item.sizes.every(size => typeof size === 'string' && sizePattern.test(size))
        || !Number.isInteger(item.maxReferenceImages) || item.maxReferenceImages < 0 || item.maxReferenceImages > 4) {
        throw protocolError();
      }
      return {
        nativeId: item.id, name: item.id, capability: 'image_generation', revision: item.revision,
        imageSizes: [...new Set(item.sizes)], maxReferenceImages: item.maxReferenceImages,
        capabilities: { text: false, image_input: item.maxReferenceImages > 0, tools: false, structured: false, thinking: false }
      };
    });
  },
  prepareImage(model, request, referenceCount) {
    const { size, aspectRatio, background } = request;
    const preferredSize = ratioSizes[aspectRatio || '1:1'];
    const requestedSize = size ?? preferredSize;
    if (!requestedSize || !model.imageSizes.includes(requestedSize)) {
      fail('Choose a size advertised by this image model.', 'unsupported_parameter', aspectRatio ? 'aspect_ratio' : 'size');
    }
    if (referenceCount > model.maxReferenceImages) {
      fail(`This model accepts up to ${model.maxReferenceImages} reference images.`, 'invalid_image_reference', 'reference_images');
    }
    if (background === 'transparent') fail('This model does not support transparent backgrounds.', 'unsupported_parameter', 'background');
    return { ...request, size: requestedSize };
  },
  tracesUsage: true,
  async generateImage(connection, { model, prompt, size, referenceImages }, { secret, signal, trace }) {
    const reference_images = referenceImages.map(({ bytes, format }) => {
      if (bytes.length > maxReferenceBytes) {
        throw new GatewayError('An MFLUX reference image exceeds 10 MiB.', 413, 'image_reference_too_large', 'reference_images');
      }
      return `data:image/${format};base64,${bytes.toString('base64')}`;
    });
    const payload = { model, prompt, size, n: 1, response_format: 'b64_json', reference_images };
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > maxRequestBytes) {
      throw new GatewayError('The encoded MFLUX request exceeds 15 MiB.', 413, 'image_reference_too_large', 'reference_images');
    }
    trace?.start(payload, secret);
    const response = await fetchUpstream(`${connection.baseUrl}/images/generations`, {
      method: 'POST', headers: headers(secret), body, signal
    }, trace);
    const result = await jsonResponse(response, Math.ceil(maxResultBytes / 3) * 4 + 64 * 1024);
    trace?.output(result);
    const encoded = result?.data?.[0]?.b64_json;
    const bytes = typeof encoded === 'string' ? imageDataByteLength(encoded) : 0;
    if (result?.model !== model || result?.data?.length !== 1 || !bytes || bytes > maxResultBytes) throw protocolError();
    const image = decodeImageData(encoded, 'png', { checkContainer: true });
    if (!image) throw protocolError();
    const { width, height } = imageInfo(image.bytes);
    if (`${width}x${height}` !== size) throw protocolError();
    return { b64_json: encoded, format: 'png', width, height };
  }
};
