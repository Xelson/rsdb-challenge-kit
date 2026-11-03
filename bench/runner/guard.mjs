// Integrity guard of the benchmark generators (SPEC §14.1). Every generator starts with
//   node --import /kit/bench/runner/guard.mjs ...
// so this module runs before the SDK under test is loaded. It captures the clock, the timers and the process functions the runner
// measures with; the runner uses only these references. `tampered()` lists the globals that no longer match at the end of a run:
// an SDK that patches them is disqualified (§14.1), whether or not the runner was affected.
const captured = {
  hrtime: process.hrtime,
  hrtimeBigint: process.hrtime.bigint,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  queueMicrotask: globalThis.queueMicrotask,
  dateNow: Date.now,
  performanceNow: globalThis.performance.now,
  memoryUsage: process.memoryUsage,
  cpuUsage: process.cpuUsage,
  send: process.send,
  exit: process.exit,
  emit: process.emit,
  stdoutWrite: process.stdout.write,
};

const hr = captured.hrtimeBigint.bind(process.hrtime);
const guard = Object.freeze({
  /** CLOCK_MONOTONIC in nanoseconds (one clock for every container on the host). */
  now: () => hr(),
  /** The same clock in milliseconds, as a float. */
  nowMs: () => Number(hr()) / 1e6,
  setTimeout: captured.setTimeout.bind(globalThis),
  clearTimeout: captured.clearTimeout.bind(globalThis),
  setInterval: captured.setInterval.bind(globalThis),
  clearInterval: captured.clearInterval.bind(globalThis),
  setImmediate: captured.setImmediate.bind(globalThis),
  queueMicrotask: captured.queueMicrotask.bind(globalThis),
  memoryUsage: captured.memoryUsage.bind(process),
  cpuUsage: captured.cpuUsage.bind(process),
  /** `global.gc` when started with --expose-gc (cli_mem). */
  gc: typeof globalThis.gc === 'function' ? globalThis.gc.bind(globalThis) : null,
  send: captured.send ? captured.send.bind(process) : null,
  exit: captured.exit.bind(process),
  write: captured.stdoutWrite.bind(process.stdout),
  /** Names of the captured globals that were replaced since startup. */
  tampered() {
    const now = {
      hrtime: process.hrtime,
      hrtimeBigint: process.hrtime.bigint,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setImmediate: globalThis.setImmediate,
      queueMicrotask: globalThis.queueMicrotask,
      dateNow: Date.now,
      performanceNow: globalThis.performance.now,
      memoryUsage: process.memoryUsage,
      cpuUsage: process.cpuUsage,
      send: process.send,
      exit: process.exit,
      emit: process.emit,
      stdoutWrite: process.stdout.write,
    };
    return Object.keys(captured).filter((k) => now[k] !== captured[k]);
  },
});

Object.defineProperty(globalThis, Symbol.for('rsdb.bench.guard'), { value: guard, enumerable: false, configurable: false, writable: false });
