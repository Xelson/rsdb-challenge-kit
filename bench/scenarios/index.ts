/** The benchmark scenarios of SPEC §14.4, in order. */
import type { Scenario } from '../lib/scenario.ts';
import b1 from './b01-broadcast.ts';
import b2 from './b02-many-queries.ts';
import b3 from './b03-topk-churn.ts';
import b4 from './b04-wide-result.ts';
import b5 from './b05-bulk-update.ts';
import b6 from './b06-subscription-churn.ts';
import b7 from './b07-cold-reads.ts';
import b8 from './b08-footprint.ts';
import b9 from './b09-slow-consumer.ts';
import b10 from './b10-cluster-fanout.ts';
import b11 from './b11-failover.ts';
import b12 from './b12-max-throughput.ts';
import b13 from './b13-mixed-queries.ts';

export const SCENARIOS: Scenario[] = [b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12, b13];
