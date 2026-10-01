"use client";

import { useTranslations } from "next-intl";
import { SectionLabel } from "@devdigest/ui";
import { useLiveRunRefresh } from "@/lib/hooks/reviews";
import { BlastRadiusCard } from "./_components/BlastRadiusCard";
import { IntentCard } from "./_components/IntentCard";
import { PrBriefCard } from "./_components/PrBriefCard";
import { s } from "./styles";

interface OverviewTabProps {
  prId: string;
  repoId: string;
  /** PR number as in the route. */
  number: string;
  /** Paths of the PR's changed files. */
  changedPaths: readonly string[];
  prBody: string | null | undefined;
  repoFullName: string | null;
  headSha: string | null;
}

export function OverviewTab({ prId, repoId, number, changedPaths, prBody, repoFullName, headSha }: OverviewTabProps) {
  const t = useTranslations("prReview");
  // A review run that ends while Overview is open refreshes the brief banner's verdict and score.
  useLiveRunRefresh(prId);
  return (
    <div style={s.stack}>
      <PrBriefCard prId={prId} repoId={repoId} number={number} changedPaths={changedPaths} headSha={headSha} />
      <div style={s.cards}>
        <IntentCard prId={prId} repoFullName={repoFullName} headSha={headSha} />
        <BlastRadiusCard prId={prId} repoId={repoId} repoFullName={repoFullName} headSha={headSha} />
      </div>
      {prBody && (
        <section>
          <SectionLabel icon="MessageSquare">{t("overview.description")}</SectionLabel>
          <div style={s.descriptionBox}>{prBody}</div>
        </section>
      )}
    </div>
  );
}
