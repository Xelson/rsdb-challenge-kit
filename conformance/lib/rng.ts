/** Seeded PRNG (sfc32 seeded by xmur3). Every random choice of a suite comes from one Rng, so a seed replays exactly. */
export class Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: number | string) {
    let h = 1779033703 ^ String(seed).length;
    for (const ch of String(seed)) {
      h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    const next = () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
    this.#a = next();
    this.#b = next();
    this.#c = next();
    this.#d = next();
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Uniform in [0, 1). */
  next(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
    this.#d = (this.#d + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#c = (this.#c + t) | 0;
    return (t >>> 0) / 4294967296;
  }
  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  /** Integer in [lo, hi]. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(a: readonly T[]): T {
    if (a.length === 0) throw new Error('pick from empty array');
    return a[this.int(a.length)]!;
  }
  shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
  sample<T>(a: readonly T[], k: number): T[] {
    return this.shuffle([...a]).slice(0, k);
  }
  /** An independent stream derived from this seed and a label (stable when other streams change). */
  fork(label: string): Rng {
    return new Rng(`${this.#a}:${this.#b}:${label}`);
  }
}
