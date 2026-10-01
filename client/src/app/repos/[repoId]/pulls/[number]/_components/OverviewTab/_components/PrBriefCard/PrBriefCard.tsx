/* PrBriefCard — the PR Brief on top of Overview (specs/2026-10-01-pr-brief.md §9):
   skeleton while loading/generating, an explanation + Generate button before the first
   brief, and with a brief: banner (verdict, score, summary, refresh), notes for missing
   inputs / stale / failed generation. All model-written text is rendered as plain text. */
"use client";

import { useTranslations } from "next-intl";
import { Button, ErrorState, Icon, Skeleton } from "@devdigest/ui";
import { ApiError } from "@/lib/api";
import { useGenerateBrief, usePrBrief, usePrReviews } from "@/lib/hooks";
import { BriefBanner } from "./_components/BriefBanner";
import { FocusList } from "./_components/FocusList";
import { RiskList } from "./_components/RiskList";
import { SKELETON_HEIGHT } from "./constants";
import { bannerStats, isBriefStale } from "./helpers";
import { s } from "./styles";
import { useOpenInDiff } from "./useOpenInDiff";

export interface PrBriefCardProps {
  prId: string;
  repoId: string;
  /** PR number as in the route (for the Files changed deep-links). */
  number: string;
  /** Paths of the PR's changed files — the only files a reference may open. */
  changedPaths: readonly string[];
  /** Head SHA of the PR as the page shows it. */
  headSha: string | null;
}

export function PrBriefCard({ prId, repoId, number, changedPaths, headSha }: PrBriefCardProps) {
  const t = useTranslations("brief");
  const { data, isLoading, isError, error, refetch } = usePrBrief(prId);
  const { data: reviews } = usePrReviews(prId);
  const generate = useGenerateBrief(prId);
  const diffLinks = useOpenInDiff({ repoId, number, changedPaths });

  if (isLoading) return <Skeleton height={SKELETON_HEIGHT} />;

  if (isError) {
    return (
      <ErrorState
        title={t("error.title")}
        body={error instanceof ApiError ? error.message : t("error.body")}
        onRetry={() => refetch()}
        retryLabel={t("retry")}
      />
    );
  }

  const brief = data?.brief ?? null;
  const generating = generate.isPending;
  const failure = generate.isError
    ? generate.error instanceof ApiError
      ? t("error.generateFailed", { message: generate.error.message })
      : t("error.generateFailedGeneric")
    : null;
  const regenerate = () => generate.mutate();

  const header = (
    <div style={s.header}>
      <Icon.Sparkles size={16} style={s.headerIcon} />
      <span style={s.headerTitle}>{t("title")}</span>
    </div>
  );
  const errorNote = failure && (
    <p role="alert" style={s.errorNote}>
      {failure}
    </p>
  );

  if (generating) {
    return (
      <section style={s.card} aria-label={t("title")} aria-busy="true">
        {header}
        <p style={s.explanation}>{t("generating")}</p>
        <Skeleton height={SKELETON_HEIGHT} />
        <div>
          <Button kind="primary" icon="Sparkles" disabled loading>
            {brief ? t("refresh") : t("empty.cta")}
          </Button>
        </div>
      </section>
    );
  }

  if (!brief) {
    return (
      <section style={s.card} aria-label={t("title")}>
        {header}
        <p style={s.explanation}>{t("empty.body")}</p>
        {errorNote}
        <div>
          <Button kind="primary" icon="Sparkles" onClick={regenerate}>
            {t("empty.cta")}
          </Button>
        </div>
      </section>
    );
  }

  const stale = isBriefStale(data?.stale ?? false, brief.head_sha, headSha);

  return (
    <section style={s.card} aria-label={t("title")}>
      {header}
      <BriefBanner
        summary={brief.summary}
        stats={bannerStats(reviews)}
        tokensIn={brief.tokens_in}
        tokensOut={brief.tokens_out}
        costUsd={brief.cost_usd}
        stale={stale}
        onRefresh={regenerate}
      />
      {(stale || errorNote || brief.missing_inputs.length > 0) && (
        <div style={s.notes}>
          {stale && <p style={s.staleNote}>{t("staleHint")}</p>}
          {errorNote}
          {brief.missing_inputs.map((m) => {
            const params = { input: t(`missing.input.${m.input}`), reason: t(`missing.reason.${m.reason}`), detail: m.detail ?? "" };
            return (
              <p key={`${m.input}/${m.reason}`} style={s.note}>
                {m.detail ? t("missing.itemDetail", params) : t("missing.item", params)}
              </p>
            );
          })}
        </div>
      )}
      <RiskList risks={brief.risks.risks} {...diffLinks} />
      <FocusList items={brief.review_focus} {...diffLinks} />
    </section>
  );
}
