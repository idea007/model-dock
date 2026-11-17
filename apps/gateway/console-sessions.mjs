import { digest, newToken } from '../../packages/core/store.mjs';
import { GatewayError } from '../../packages/protocol/index.mjs';

const linkLifetime = 5 * 60_000;
const sessionLifetime = 7 * 24 * 60 * 60_000;

function issue(secrets, prefix, lifetime) {
  const now = Date.now();
  for (const [key, expires] of secrets) if (expires <= now) secrets.delete(key);
  const secret = newToken(prefix);
  secrets.set(digest(secret), now + lifetime);
  return secret;
}

export class ConsoleSessions {
  #links = new Map();
  #sessions = new Map();

  link(origin) {
    const code = issue(this.#links, 'md_console_link', linkLifetime);
    return `${origin}/?view=connections#session=${code}`;
  }

  redeem(code, current) {
    const key = typeof code === 'string' ? digest(code) : '';
    const expires = this.#links.get(key);
    this.#links.delete(key);
    if (expires === undefined || expires <= Date.now()) {
      throw new GatewayError('打开链接已失效，请重新从终端打开管理台。', 401, 'console_link_expired');
    }
    if (this.authenticate(current)) return current;
    return issue(this.#sessions, 'md_console', sessionLifetime);
  }

  authenticate(token) {
    if (!token?.startsWith('md_console_')) return false;
    const key = digest(token);
    if (this.#sessions.get(key) > Date.now()) return true;
    this.#sessions.delete(key);
    return false;
  }

  revoke(token) {
    if (token) this.#sessions.delete(digest(token));
  }
}
