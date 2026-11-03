# RSDB Challenge — infrastructure runbook

Organizers follow this procedure when something outside a harness fails during a run (SPEC §16.3). It applies identically to both
harnesses. Time lost is never refunded, and nothing here may be used to help a harness with its work.

## 1. Classify the failure

| Symptom | Class | Section |
|---|---|---|
| The harness's top-level process exited and the `submission` tag is not pushed, with no infrastructure symptom below | harness stopped: a nudge, not this runbook | SPEC §16.3 |
| The dev machine is unreachable, rebooted, out of disk, or its kernel or Docker daemon failed | machine | 2 |
| The dev machine cannot reach an allowlisted host (P10) while the host itself is up | network | 3 |
| The gateway refuses or drops requests for reasons other than the cost cap | gateway | 4 |
| The provider returns 5xx or overload errors to every client of the gateway, confirmed on its status page | provider | 5 |
| A provider rate limit (429) under the harness's declared tier | not infrastructure: part of the harness | SPEC §16.3 |
| The cost cap was reached | end of run | SPEC §16.3 |

When in doubt, organizers decide jointly, record the decision with its evidence in `RESULTS/interventions.log` and publish it.
Rules that apply to every class:

- Never send the harness anything except the fixed text of §6, and only after the infrastructure is restored.
- Never touch the repository, the working tree or the harness's state beyond what a step below names.
- Record every action in `RESULTS/interventions.log`: ISO time, `type: infrastructure`, class, what was observed, what was done.

## 2. Machine failure

1. Snapshot what is left: if the disk is readable, copy the working tree, the harness's telemetry and transcript directories and the
   auditd log to organizer storage, with sha256 hashes.
2. If the machine can be restarted with its disk intact, restart it and go to step 4.
3. Otherwise provision a new machine from the same image (P5), restore the harness's frozen configuration from the manifest (SPEC §16.1),
   restore the working tree from the snapshot of step 1, or from `origin/main` if no snapshot exists. Uncommitted work that could not be
   recovered is lost.
4. Check: Docker works, `kit/docker/build.sh base` images are present, the egress allowlist is active, telemetry shipping works
   (one test event reaches organizer storage), and the push key works (`git ls-remote origin`).
5. Resume the harness (§6).

## 3. Network failure

1. Confirm from a second machine that the allowlisted host is up; if it is down for everyone, it is not a network failure of the run.
2. Restore the route or firewall rule. Do not widen the allowlist.
3. If the harness stopped because of the failure, resume it (§6); otherwise do nothing.

## 4. Gateway failure

1. Confirm from the gateway's own log and health check that the failure is in the gateway, not in the provider.
2. Restart the gateway from the approved commit (SPEC §16.1). Its append-only log MUST survive; if it does not, stop and record a
   verification incident: the requests in the gap are reconciled from the provider's usage report alone and listed in `RESULTS/verify.txt`.
3. Check that the run keys work and that the cost-cap counter continues from its previous value.
4. If the harness stopped because of the failure, resume it (§6).

## 5. Provider outage

1. Confirm on the provider's status page and with a request from a key outside the run.
2. Wait. Do not switch providers, models or tiers for the harness.
3. When the provider recovers, resume the harness if it stopped (§6).

## 6. Resuming a harness

Use the resume command declared in `HARNESS.md` (for harness A: `claude -p --continue`) with exactly this text:

> Infrastructure was restored. Continue working on the challenge until you push the submission tag.

These resumes are not nudges. If the harness is still running, do not resume it.

## 7. After the run

List every infrastructure event, with its duration, in `RESULTS/interventions.log` and in the run summary of `README.md`.
