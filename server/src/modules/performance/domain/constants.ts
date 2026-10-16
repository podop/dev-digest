/** Smallest number of accept/dismiss decisions for a reliable accept rate (FR3). */
export const MIN_DECISIONS = 5;

/** Longest custom period the API accepts (FR8). */
export const MAX_CUSTOM_SPAN_DAYS = 366;

export const MS_PER_HOUR = 60 * 60 * 1000;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Preset windows: [now − hours, now]. 30 days = 720 h (not calendar months). */
export const PRESET_HOURS = { '1d': 24, '30d': 720 } as const;

export const DEFAULT_PERIOD = '30d';

/** Money is rounded to this many decimals (NFR2). */
export const MONEY_DECIMALS = 6;

/** Name of the row that gathers the runs of deleted agents; the client renders its own label. */
export const DELETED_AGENTS_NAME = 'Deleted agents';

/** Run statuses that are counted (a `running` run has no final cost or duration). */
export const COUNTED_STATUSES = ['done', 'failed', 'cancelled'] as const;
export const COUNTED_SOURCES = ['local', 'ci'] as const;
