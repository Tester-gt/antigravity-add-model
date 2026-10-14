export const COMPACTION_EFFORTS = ['inherit', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type CompactionEffort = typeof COMPACTION_EFFORTS[number];

export function validateCompactionEffort(value: unknown): CompactionEffort {
  if (!COMPACTION_EFFORTS.includes(value as CompactionEffort)) throw new Error('Invalid compaction reasoning effort');
  return value as CompactionEffort;
}
