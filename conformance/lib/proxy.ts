/**
 * A TCP proxy inside the judge process that can cut every connection through it at once (T6, R10), or freeze them: nothing is
 * forwarded and nothing is closed, so only a heartbeat can tell (F4: the SDK detects a silent connection within 5 s).
 */
import net from 'node:net';

export class CutProxy {
  readonly #target: { host: string; port: number };
  readonly #pairs = new Set<[net.Socket, net.Socket | null]>();
  #server: net.Server | null = null;
  #frozen = false;
  cuts = 0;

  constructor(targetUrl: string) {
    const u = new URL(targetUrl);
    this.#target = { host: u.hostname, port: Number(u.port || 80) };
  }

  /** Starts listening on a free local port; returns the URL clients should use. */
  async start(): Promise<string> {
    const server = net.createServer((down) => {
      down.on('error', () => {});
      if (this.#frozen) {
        // Accepted, never answered.
        const pair: [net.Socket, null] = [down, null];
        this.#pairs.add(pair);
        down.on('close', () => this.#pairs.delete(pair));
        return;
      }
      const up = net.connect(this.#target.port, this.#target.host);
      const pair: [net.Socket, net.Socket] = [down, up];
      this.#pairs.add(pair);
      for (const s of pair) {
        s.setNoDelay(true);
        s.on('error', () => {});
        s.on('close', () => {
          this.#pairs.delete(pair);
          down.destroy();
          up.destroy();
        });
      }
      down.pipe(up);
      up.pipe(down);
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  }

  /** Resets every open connection (both directions). */
  cutAll(): void {
    this.cuts++;
    for (const [down, up] of this.#pairs) {
      down.resetAndDestroy();
      up?.resetAndDestroy();
    }
    this.#pairs.clear();
  }

  /** Stops forwarding in both directions on every connection, open or new, without closing any. */
  freeze(): void {
    this.#frozen = true;
    for (const [down, up] of this.#pairs) {
      if (!up) continue;
      down.unpipe(up);
      up.unpipe(down);
      down.pause();
      up.pause();
    }
  }

  async close(): Promise<void> {
    this.cutAll();
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }
}
