import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const allowed = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'CODEX_HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_DIR', 'SSL_CERT_FILE'];
const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

export function loopbackSystemProxies(output) {
  const field = name => String(output).match(new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, 'm'))?.[1];
  const result = {};
  for (const protocol of ['HTTP', 'HTTPS']) {
    const host = field(`${protocol}Proxy`), port = Number(field(`${protocol}Port`));
    if (field(`${protocol}Enable`) !== '1' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    result[`${protocol}_PROXY`] = `http://${host === '::1' ? '[::1]' : host}:${port}`;
  }
  return result;
}

export async function createCodexEnvironment({ source = process.env, platform = process.platform, readProxy = async () => (await execute('/usr/sbin/scutil', ['--proxy'], { timeout: 2000, maxBuffer: 64 * 1024 })).stdout } = {}) {
  const env = Object.fromEntries(allowed.filter(key => source[key] !== undefined).map(key => [key, String(source[key])]));
  // An explicitly set proxy, including an empty value, always wins. Never edit OS settings.
  if (platform === 'darwin' && !proxyKeys.some(key => source[key] !== undefined)) {
    try {
      const proxies = loopbackSystemProxies(await readProxy());
      Object.assign(env, proxies);
      if (Object.keys(proxies).length && source.NO_PROXY === undefined && source.no_proxy === undefined) env.NO_PROXY = 'localhost,127.0.0.1,::1';
    } catch { /* Proxy detection is optional; the CLI retains its normal network behavior. */ }
  }
  return env;
}
