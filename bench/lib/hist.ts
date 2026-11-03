/**
 * Log-linear histogram of non-negative values in microseconds (HDR-style, SPEC §14.2): exact below 128 µs, then 64 sub-buckets per
 * power of two, so every recorded value is within 1/64 of its bucket's midpoint. Histograms of several processes merge by adding
 * counts; the maximum is kept exactly.
 */
const LINEAR = 128;
const SUB = 64;
const MAX_EXP = 31;
const SIZE = LINEAR + (MAX_EXP - 7) * SUB;

function index(us: number): number {
  if (us < LINEAR) return us;
  const b = 31 - Math.clz32(us);
  const shift = b - 6;
  return LINEAR + (b - 7) * SUB + ((us >>> shift) - SUB);
}

function midpoint(i: number): number {
  if (i < LINEAR) return i;
  const k = i - LINEAR;
  const shift = Math.floor(k / SUB) + 1;
  const low = ((k % SUB) + SUB) * 2 ** shift;
  return low + 2 ** shift / 2;
}

export interface HistSummary {
  n: number;
  p50: number;
  p99: number;
  p999: number;
  max: number;
}

export interface HistJson {
  n: number;
  max: number;
  /** [bucket, count] pairs of the non-empty buckets. */
  b: [number, number][];
}

export class Hist {
  #counts = new Float64Array(SIZE);
  n = 0;
  maxUs = 0;

  /** Records a value in milliseconds. */
  add(ms: number): void {
    const us = Math.min(2 ** MAX_EXP - 1, Math.max(0, Math.round(ms * 1000)));
    this.#counts[index(us)]! += 1;
    this.n += 1;
    if (us > this.maxUs) this.maxUs = us;
  }

  merge(other: Hist | HistJson): this {
    const o = other instanceof Hist ? other.toJSON() : other;
    for (const [i, c] of o.b) this.#counts[i]! += c;
    this.n += o.n;
    this.maxUs = Math.max(this.maxUs, o.max);
    return this;
  }

  /** Value at quantile q in milliseconds; NaN when empty. */
  quantile(q: number): number {
    if (this.n === 0) return NaN;
    const rank = Math.max(1, Math.ceil(q * this.n));
    let seen = 0;
    for (let i = 0; i < SIZE; i++) {
      seen += this.#counts[i]!;
      if (seen >= rank) return Math.min(midpoint(i), this.maxUs) / 1000;
    }
    return this.maxUs / 1000;
  }

  summary(): HistSummary {
    return { n: this.n, p50: this.quantile(0.5), p99: this.quantile(0.99), p999: this.quantile(0.999), max: this.maxUs / 1000 };
  }

  toJSON(): HistJson {
    const b: [number, number][] = [];
    for (let i = 0; i < SIZE; i++) if (this.#counts[i]) b.push([i, this.#counts[i]!]);
    return { n: this.n, max: this.maxUs, b };
  }

  static from(j: HistJson): Hist {
    return new Hist().merge(j);
  }
}
