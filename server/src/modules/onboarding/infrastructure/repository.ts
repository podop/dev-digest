/**
 * onboarding data access (infrastructure; implements OnboardingStore). The tour
 * lives in `onboarding.json` (one row per repo). A stored value that no longer
 * matches the contract (an older shape) reads as "no tour": it is parsed with
 * `safeParse`, never thrown on.
 */
import { and, eq } from 'drizzle-orm';
import { OnboardingTour } from '@devdigest/shared';
import type { DbOrTx } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { OnboardingRepo, OnboardingStore } from '../application/ports.js';

export class OnboardingRepository implements OnboardingStore {
  constructor(private readonly db: DbOrTx) {}

  async findRepo(workspaceId: string, repoId: string): Promise<OnboardingRepo | null> {
    const [row] = await this.db
      .select({
        id: t.repos.id,
        owner: t.repos.owner,
        name: t.repos.name,
        fullName: t.repos.fullName,
        defaultBranch: t.repos.defaultBranch,
      })
      .from(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, repoId)));
    return row ?? null;
  }

  async getTour(repoId: string): Promise<OnboardingTour | null> {
    const [row] = await this.db
      .select({ json: t.onboarding.json })
      .from(t.onboarding)
      .where(eq(t.onboarding.repoId, repoId));
    if (!row) return null;
    const parsed = OnboardingTour.safeParse(row.json);
    return parsed.success ? parsed.data : null;
  }

  async upsertTour(repoId: string, tour: OnboardingTour): Promise<void> {
    const generatedAt = new Date(tour.generated_at);
    await this.db
      .insert(t.onboarding)
      .values({ repoId, json: tour, generatedAt })
      .onConflictDoUpdate({ target: t.onboarding.repoId, set: { json: tour, generatedAt } });
  }
}
