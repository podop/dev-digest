/* IntentCard — the PR's derived intent (server/specs/05-intent-layer.md):
   plain-text intent, change-type chip, confidence badge, inferred/stale hints,
   in/out-of-scope columns, sources (client-built links), model/cost, Refresh.
   Empty state (no derivation yet) offers a "Derive now" CTA. */
"use client";

import { useTranslations } from "next-intl";
import { Badge, Button, EmptyState, ErrorState, Icon, Skeleton } from "@devdigest/ui";
import { ApiError } from "@/lib/api";
import { usePrIntent, useRefreshIntent } from "@/lib/hooks/intent";
import { formatUsd } from "@/lib/format-usage";
import { confidenceColor, isSourceOk, sourceHref, sourceIcon } from "./helpers";
import { s } from "./styles";

export interface IntentCardProps {
  prId: string;
  repoFullName: string | null;
  headSha: string | null;
}

export function IntentCard({ prId, repoFullName, headSha }: IntentCardProps) {
  const t = useTranslations("prReview");
  const tc = useTranslations("common");
  const { data, isLoading, isError, error, refetch } = usePrIntent(prId);
  const refresh = useRefreshIntent(prId);

  if (isLoading) return <Skeleton height={140} />;

  // Distinct from "never derived": a failed GET must not look like the empty
  // state (refresh-mutation errors are already toasted by the global
  // MutationCache — client/INSIGHTS.md — so this is the only error surface here).
  if (isError) {
    return (
      <ErrorState
        title={t("intent.error.title")}
        body={error instanceof ApiError ? error.message : t("intent.error.body")}
        onRetry={() => refetch()}
        retryLabel={tc("actions.retry")}
      />
    );
  }

  const intent = data?.intent ?? null;
  if (!intent) {
    return (
      <EmptyState
        icon="Target"
        title={t("intent.empty.title")}
        body={t("intent.empty.body")}
        cta={t("intent.empty.cta")}
        ctaLoading={refresh.isPending}
        onCta={() => refresh.mutate()}
      />
    );
  }

  const color = confidenceColor(intent.confidence);

  return (
    <section style={s.card} aria-label={t("intent.title")}>
      <div style={s.header}>
        <Icon.Target size={16} style={s.headerIcon} />
        <span style={s.headerTitle}>{t("intent.title")}</span>
        <div style={s.headerRight}>
          {intent.change_type && <Badge>{t(`intent.changeType.${intent.change_type}`)}</Badge>}
          {intent.confidence && (
            <Badge color={color.fg} bg={color.bg}>
              {t(`intent.confidence.${intent.confidence}`)}
            </Badge>
          )}
          <Button kind="ghost" size="sm" icon="RefreshCw" loading={refresh.isPending} onClick={() => refresh.mutate()}>
            {t("intent.refresh")}
          </Button>
        </div>
      </div>

      {intent.derived_from === "inferred" && <p style={s.hint}>{t("intent.inferredHint")}</p>}
      {data?.stale && <p style={s.hint}>{t("intent.staleHint")}</p>}

      <p style={s.text}>{`“${intent.intent}”`}</p>

      {(intent.in_scope.length > 0 || intent.out_of_scope.length > 0) && (
        <div style={s.scopeGrid}>
          {intent.in_scope.length > 0 && <ScopeBlock inScope label={t("intent.inScope")} lines={intent.in_scope} />}
          {intent.out_of_scope.length > 0 && <ScopeBlock inScope={false} label={t("intent.outOfScope")} lines={intent.out_of_scope} />}
        </div>
      )}

      {intent.sources && intent.sources.length > 0 && (
        <div style={s.sourcesBlock}>
          <div style={s.sourcesLabel}>{t("intent.sources")}</div>
          <ul style={s.sourceList}>
            {intent.sources.map((src, i) => {
              const SourceIcon = Icon[sourceIcon(src.kind)];
              const href = repoFullName ? sourceHref(src, repoFullName, headSha) : undefined;
              const ok = isSourceOk(src.status);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: sources have no stable id
                <li key={`${src.kind}-${src.ref}-${i}`} style={s.sourceRow}>
                  <SourceIcon size={13} style={s.sourceIcon} />
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer" style={s.sourceRef}>
                      {src.ref}
                    </a>
                  ) : (
                    <span style={s.sourceRefPlain}>{src.ref}</span>
                  )}
                  <span style={s.sourceStatus(ok)}>
                    {t(`intent.sourceStatus.${src.status}`)}
                    {src.detail ? ` — ${src.detail}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div style={s.footer}>
        <span className="mono" style={s.footerModel}>
          {intent.model}
        </span>
        <span>{formatUsd(intent.cost_usd)}</span>
      </div>
    </section>
  );
}

/** One scope column: "✓ IN SCOPE" (green, normal items) or "✕ OUT OF SCOPE" (muted items). */
function ScopeBlock({ inScope, label, lines }: { inScope: boolean; label: string; lines: string[] }) {
  const Mark = inScope ? Icon.Check : Icon.X;
  return (
    <div style={s.scopeBlock}>
      <div style={s.scopeLabel(inScope)}>
        <Mark size={13} />
        {label}
      </div>
      <ul style={s.scopeList}>
        {lines.map((line) => (
          <li key={line} style={s.scopeItem(inScope)}>
            <span aria-hidden="true" style={s.scopeDot(inScope)}>
              ·
            </span>
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}
