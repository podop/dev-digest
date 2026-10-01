/* BlastRadiusCard — "what else can this diff hit?" (server/specs/07-blast-radius.md,
   client/specs/07-blast-radius.md): stat row, symbol tree, endpoint/cron chips.
   Read from GET /pulls/:id/blast (an index read). A degraded answer is shown as
   "unknown", never as an empty "no impact" — with a Resync button. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, ErrorState, Icon, Skeleton } from "@devdigest/ui";
import { ApiError } from "@/lib/api";
import { useBlastRadius, useResyncBlast } from "@/lib/hooks/blast";
import { BlastGraph } from "./_components/BlastGraph";
import { BlastTree } from "./_components/BlastTree";
import { PriorPrs } from "./_components/PriorPrs";
import { blastStats, callerHref, degradedReasonKey } from "./helpers";
import { s } from "./styles";

export interface BlastRadiusCardProps {
  prId: string;
  repoId: string;
  repoFullName: string | null;
  headSha: string | null;
}

export function BlastRadiusCard({ prId, repoId, repoFullName, headSha }: BlastRadiusCardProps) {
  const t = useTranslations("blast");
  const tc = useTranslations("common");
  const { data, isLoading, isError, error, refetch } = useBlastRadius(prId);
  const resync = useResyncBlast(repoId, prId);
  const [view, setView] = React.useState<"tree" | "graph">("tree");

  if (isLoading) return <Skeleton height={140} />;
  if (isError || !data) {
    return (
      <ErrorState
        title={t("error.title")}
        body={error instanceof ApiError ? error.message : t("error.body")}
        onRetry={() => refetch()}
        retryLabel={tc("actions.retry")}
      />
    );
  }

  const stats = blastStats(data);
  const degraded = data.degraded === true;

  return (
    <section style={s.card} aria-label={t("title")}>
      <div style={s.header}>
        <Icon.Target size={16} style={s.headerIcon} />
        <span style={s.headerTitle}>{t("title")}</span>
        <div style={s.headerRight} role="group" aria-label={t("view.label")}>
          {(["tree", "graph"] as const).map((v) => (
            <Button key={v} kind="ghost" size="sm" active={view === v} aria-pressed={view === v} onClick={() => setView(v)}>
              {t(`view.${v}`)}
            </Button>
          ))}
        </div>
      </div>

      <ul style={s.stats}>
        {(["symbols", "callers", "endpoints", "crons"] as const).map((key) => (
          <li key={key} style={s.stat}>
            <span className="mono" style={s.statValue}>
              {stats[key]}
            </span>
            <span style={s.statLabel}>{t(`stat.${key}`)}</span>
          </li>
        ))}
      </ul>

      {degraded && (
        <div style={s.degraded} role="status">
          <Badge icon="AlertTriangle" color="var(--warn)" bg="transparent">
            {t("degraded.badge")}
          </Badge>
          <span style={s.degradedText}>
            {t(`degraded.reason.${degradedReasonKey(data.reason)}`)} {t("degraded.notImpact")}
            {resync.isSuccess && ` ${t("degraded.resyncStarted")}`}
          </span>
          <Button kind="secondary" size="sm" icon="RefreshCw" loading={resync.isPending} onClick={() => resync.mutate()}>
            {t("degraded.resync")}
          </Button>
        </div>
      )}

      {view === "graph" ? (
        <BlastGraph downstream={data.downstream} />
      ) : data.downstream.length > 0 ? (
        <BlastTree downstream={data.downstream} callerHref={(c) => callerHref(repoFullName, headSha, c)} />
      ) : (
        !degraded && (
          <p style={s.muted}>{stats.symbols > 0 ? t("noDownstream", { count: stats.symbols }) : t("noSymbols")}</p>
        )
      )}

      <PriorPrs prId={prId} repoFullName={repoFullName} />
    </section>
  );
}
