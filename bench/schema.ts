/** Benchmark schema (SPEC §14.3). Scored runs use a renamed, permuted variant of it. */
import { defineSchema, t, table } from '@rsdb/client';

export default defineSchema({
  tables: {
    messages: table({
      channel: t.int(),
      author: t.string(),
      body: t.string(),
      ts: t.float(),
      sentAt: t.float(),
      meta: t.json<{ tags?: string[] }>().optional(),
    }).index('by_channel_ts', ['channel', 'ts']),
    users: table({
      name: t.string(),
      team: t.int(),
      score: t.int(),
      active: t.bool().default(true),
      sentAt: t.float().default(0),
    })
      .index('by_team_score', ['team', 'score'])
      .index('by_score', ['score']),
    counters: table({
      value: t.int().default(0),
    }),
  },
});
