/**
 * Barriers between the bench controller and its generator processes. A generator posts `sync(name, data)` and blocks until the
 * controller releases that barrier with a payload; the controller gathers the data of every generator it waits for. Long polls on
 * plain node:http with timeouts disabled, because a barrier can span a whole measurement window.
 */
import http from 'node:http';

interface Waiter {
  data: unknown;
  res: http.ServerResponse;
}

export class Control {
  #server: http.Server;
  #waiting = new Map<string, Map<string, Waiter>>();
  #wake: (() => void) | null = null;

  constructor() {
    this.#server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const { id, name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          let m = this.#waiting.get(name);
          if (!m) this.#waiting.set(name, (m = new Map()));
          m.set(id, { data, res });
          this.#wake?.();
        } catch (e) {
          res.writeHead(400).end(String(e));
        }
      });
    });
    this.#server.requestTimeout = 0;
    this.#server.headersTimeout = 0;
    this.#server.keepAliveTimeout = 0;
    this.#server.timeout = 0;
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => this.#server.listen(port, '0.0.0.0', resolve));
  }

  /**
   * Waits until every id has posted `name`. `check` runs about once a second and returns an error message when a generator died;
   * the gather then fails with it.
   */
  async gather<T = any>(name: string, ids: readonly string[], o: { timeoutMs?: number; check?: () => Promise<string | null> } = {}): Promise<Map<string, T>> {
    const deadline = Date.now() + (o.timeoutMs ?? 600_000);
    let lastCheck = Date.now();
    for (;;) {
      const m = this.#waiting.get(name);
      if (ids.every((id) => m?.has(id))) return new Map(ids.map((id) => [id, m!.get(id)!.data as T]));
      if (Date.now() > deadline) {
        const missing = ids.filter((id) => !m?.has(id));
        throw new Error(`barrier ${name}: no answer from ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}`);
      }
      if (o.check && Date.now() - lastCheck > 1000) {
        lastCheck = Date.now();
        const err = await o.check();
        if (err) throw new Error(`barrier ${name}: ${err}`);
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, 200);
        this.#wake = () => {
          clearTimeout(t);
          r();
        };
      });
      this.#wake = null;
    }
  }

  /** Answers every generator waiting on `name`. */
  release(name: string, payload: unknown | ((id: string) => unknown) = null): void {
    const m = this.#waiting.get(name);
    if (!m) return;
    this.#waiting.delete(name);
    for (const [id, w] of m) {
      const body = JSON.stringify(typeof payload === 'function' ? (payload as (id: string) => unknown)(id) : payload) ?? 'null';
      w.res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    }
  }

  /** gather + release with the same payload for all. */
  async barrier<T = any>(name: string, ids: readonly string[], payload: unknown = null, o: Parameters<Control['gather']>[2] = {}): Promise<Map<string, T>> {
    const got = await this.gather<T>(name, ids, o);
    this.release(name, payload);
    return got;
  }

  close(): void {
    for (const m of this.#waiting.values()) for (const w of m.values()) w.res.destroy();
    this.#waiting.clear();
    this.#server.close();
    this.#server.closeAllConnections();
  }
}

/** Generator side: posts `data` under barrier `name` and resolves with the controller's payload. */
export function sync<T = any>(base: string, id: string, name: string, data: unknown = null): Promise<T> {
  const url = new URL(base);
  const body = JSON.stringify({ id, name, data });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: 'POST', path: '/sync', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`sync ${name}: HTTP ${res.statusCode} ${text}`));
        resolve(JSON.parse(text) as T);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
