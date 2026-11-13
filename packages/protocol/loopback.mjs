import { GatewayError } from './index.mjs';

// Used by both local servers. Fetch Metadata is browser-controlled; a different
// local port is same-site, not same-origin. Bearer authentication is still required.
// https://www.w3.org/TR/fetch-metadata/#sec-fetch-site-header
export function assertLoopbackRequest(request, port) {
  const host = request.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) {
    throw new GatewayError('This service accepts loopback hosts only.', 403, 'host_forbidden');
  }
  const origin = request.headers.origin, site = request.headers['sec-fetch-site'];
  if (site === 'cross-site') throw new GatewayError('Cross-site requests are not allowed.', 403, 'origin_forbidden');
  if (!origin || origin === `http://${host}`) return;

  // Some request modifiers strip only the Origin port. Accept that precise case
  // only when independent Fetch Metadata still identifies a same-origin request.
  // Do not accept other ports, hostnames, opaque origins, or missing metadata.
  const hostname = host.slice(0, host.lastIndexOf(':'));
  if (site === 'same-origin' && origin === `http://${hostname}`) return;
  throw new GatewayError('Cross-origin requests are not allowed.', 403, 'origin_forbidden');
}
