/**
 * Structural shape of the repo-intel blast read — declared here (not imported
 * from modules/repo-intel) so the blast module reaches that module only through
 * the composition root (server/INSIGHTS.md). repo-intel's `BlastResult` is
 * assignable to it.
 */
import type { BlastDegradedReason } from '@devdigest/shared';

export interface BlastResultChangedSymbol {
  file: string;
  name: string;
  kind: string;
}

export interface BlastResultCaller {
  file: string;
  /** Enclosing symbol of the reference. */
  symbol: string;
  /** Which changed symbol this caller reaches. */
  viaSymbol: string;
  line: number;
  rank: number;
}

export interface BlastResult {
  changedSymbols: BlastResultChangedSymbol[];
  callers: BlastResultCaller[];
  /** Present only on the persistent (non-degraded) path. */
  factsByFile?: Record<string, { endpoints: string[]; crons: string[] }>;
  degraded?: boolean;
  reason?: BlastDegradedReason;
}
