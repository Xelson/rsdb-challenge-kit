/** Minimal Docker Engine API client over the mounted socket (no CLI inside the judge container). */
import http from 'node:http';

const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';

export class DockerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`docker ${status}: ${message}`);
    this.status = status;
  }
}

export function docker<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, method, path: `/v1.43${path}`, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode! >= 400) return reject(new DockerError(res.statusCode!, buf.toString('utf8').trim()));
        const ct = res.headers['content-type'] ?? '';
        resolve((ct.includes('json') && buf.length ? JSON.parse(buf.toString('utf8')) : buf) as T);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`docker ${method} ${path} timed out`)));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Demultiplexes a non-TTY log stream into text. */
export function demux(buf: Buffer): string {
  let out = '';
  for (let i = 0; i + 8 <= buf.length;) {
    const len = buf.readUInt32BE(i + 4);
    out += buf.subarray(i + 8, i + 8 + len).toString('utf8');
    i += 8 + len;
  }
  return out;
}

export async function logs(container: string, tail = 200): Promise<string> {
  try {
    return demux(await docker<Buffer>('GET', `/containers/${container}/logs?stdout=1&stderr=1&tail=${tail}`));
  } catch (e) {
    return String(e);
  }
}

export async function ensureImage(image: string): Promise<void> {
  await docker('GET', `/images/${encodeURIComponent(image)}/json`).catch(() => {
    throw new Error(`image ${image} not found: build it first (kit/docker/build.sh)`);
  });
}
