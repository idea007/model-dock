import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GatewayError } from '../protocol/index.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const videoIdPattern = /^video_[a-f0-9]{32}$/;

export class ServiceOwnership {
  constructor(directory) {
    this.directory = join(directory, 'service-ownership');
  }
  path(connection, kind, id) {
    return join(this.directory, digest([connection.id, kind, id]));
  }
  async owns(principal, connection, kind, id) {
    if (!id) return false;
    try { return await readFile(this.path(connection, kind, id), 'utf8') === principal.id; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async claim(principal, connection, kind, id) {
    const inserted = await this.#insert(this.path(connection, kind, id), principal.id);
    if (!inserted && !await this.owns(principal, connection, kind, id)) {
      throw new GatewayError('This provider operation already has an owner.', 409, 'service_operation_conflict');
    }
  }
  async saveVideo(principal, connection, deployment, taskId, { seconds, size }) {
    const source = [connection.id, connection.baseUrl, connection.credentialId, connection.service];
    const id = `video_${digest([principal.id, source, taskId]).slice(0, 32)}`;
    const job = { id, owner: principal.id, deployment, taskId, source, seconds, size, createdAt: Math.floor(Date.now() / 1000) };
    const inserted = await this.#insert(join(this.directory, id), JSON.stringify(job));
    return inserted ? job : this.video(principal, id);
  }
  async video(principal, id) {
    const missing = () => new GatewayError('Video not found.', 404, 'video_not_found');
    if (!videoIdPattern.test(id)) throw missing();
    let job;
    try { job = JSON.parse(await readFile(join(this.directory, id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw missing(); throw error; }
    if (job.owner !== principal.id) throw missing();
    return job;
  }
  async #insert(path, value) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
      await link(temporary, path);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST' || error.syscall !== 'link') throw error;
      return false;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
