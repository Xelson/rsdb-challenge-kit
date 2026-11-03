# Token Accounting Gate — calibration (SPEC §17.2)

Each harness passes this preflight before kickoff, on its **calibration** gateway key and calibration provider workspace (SPEC §16.1).
Nothing from the calibration is reused in the run except the evidence published in `RESULTS/calibration/`.

## 1. Preparation (organizers)

1. Create an empty scratch repository `rsdb-calibration-<harness>` that the dev machine can push to. It contains only `TASK.md` with the
   task of §2. It contains no file of this kit.
2. Start the harness exactly as it will start for the run (same machine image, frozen configuration, launch script, telemetry shipping
   to organizer storage, gateway URL), except that it uses the calibration key and works in the scratch repository.
3. Budget: at most 45 minutes and $15 at list price. The gateway enforces the dollar limit on the calibration key.

## 2. Calibration task (given verbatim)

> Read `TASK.md`. In this repository, write a TypeScript module `interval-set.ts` for Node 24 that stores a set of half-open integer
> intervals and supports `add(from, to)`, `remove(from, to)`, `has(x)` and `toArray()` (sorted, merged intervals). Write tests with
> `node:test` that cover merging, splitting, empty and adjacent intervals, and a randomized comparison against a naive implementation.
> Plan before you implement, review your work before you finish, then commit, push to `origin/main`, and stop.

The task is small on purpose. It must make **every component declared in `HARNESS.md`** issue at least one billed request. A component
that only runs in long sessions (for example context compaction, or a reviewer triggered after N changes) needs a switch in the frozen
configuration that makes it run during calibration; the switch, and the evidence that the run uses the same code path, are declared in
`HARNESS.md`.

## 3. Evidence

After the harness stops:

1. Organizers snapshot the native records into `RESULTS/calibration/raw/` with sha256 hashes, as at the run deadline (SPEC §16.4).
2. The frozen converter (SPEC §17.5) turns them into `RESULTS/calibration/usage-events.jsonl` and `RESULTS/calibration/usage.json`.
3. Organizers export the gateway log for the calibration key into `RESULTS/calibration/gateway/` (format:
   `gateway-record.schema.json`). A provider report (`provider-report.schema.json`) in `RESULTS/calibration/provider/` is optional here.
4. Run the verifier inside the kit Node image:

   ```bash
   node kit/accounting/verify/verify.ts RESULTS --calibration --transcripts RESULTS/calibration/raw
   ```

   It writes `RESULTS/calibration/verify.txt` and `verify.json` and exits 0 only if every check passes.

## 4. Abort-path test

SPEC §17.2 point 2 requires a harness that cannot measure its usage to stop before doing any work. Organizers check it once:

1. Start the harness on the calibration key with its usage source disabled the way `HARNESS.md` names (for harness A: telemetry
   variables unset, see Appendix A of the specification).
2. Pass: within 2 minutes the harness prints a line starting with `RSDB_ABORT TOKEN_ACCOUNTING_UNAVAILABLE:`, exits with status 86,
   and the gateway shows at most the requests the preflight itself made (none that work on the task).

## 5. Outcome

The gate passes when §3 exits 0 and §4 passes. Otherwise the harness may fix its converter or launch script and repeat the calibration
until the configuration freeze; after the freeze (SPEC §16.1) a failing gate is a forfeit (SPEC §15.3).
