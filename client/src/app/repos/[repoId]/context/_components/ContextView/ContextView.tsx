/* ContextView — /repos/:repoId/context: the spec / doc / insight markdown files
   of the repo's clone (view-only), a filter, and a preview of the selected one.
   The selection lives in the URL (?doc=). */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { EmptyState, ErrorState, IconBtn, Skeleton, TextInput } from "@devdigest/ui";
import { AppShell } from "@/components/app-shell";
import { RepoNotFound } from "@/components/repo-not-found";
import { useContextDocs, useRefreshContext, useRepos } from "@/lib/hooks";
import { useRepoNotFound } from "@/lib/repo-context";
import { contextHref, filterDocs, splitPath } from "./helpers";
import { DocList } from "./_components/DocList";
import { DocPreviewPane } from "./_components/DocPreviewPane";
import { s } from "./styles";

export function ContextView({ repoId, doc }: { repoId: string; doc: string | null }) {
  const t = useTranslations("context");
  const tc = useTranslations("common");
  const router = useRouter();
  const repoNotFound = useRepoNotFound(repoId);
  const { data: repos } = useRepos();
  const { data: list, isLoading, isError, refetch } = useContextDocs(repoId);
  const refresh = useRefreshContext(repoId);
  const [query, setQuery] = React.useState("");

  const repoName = repos?.find((r) => r.id === repoId)?.full_name;
  const crumb = [
    ...(repoName ? [{ label: repoName, mono: true }] : []),
    { label: t("title") },
    ...(doc ? [{ label: splitPath(doc).name, mono: true }] : []),
  ];
  const docs = list?.docs ?? [];
  const visible = filterDocs(docs, query);
  const globs = list?.globs.join(", ") ?? "";
  const select = (path: string) => router.replace(contextHref(repoId, path), { scroll: false });

  if (repoNotFound) {
    return (
      <AppShell crumb={crumb}>
        <RepoNotFound />
      </AppShell>
    );
  }

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>
        <aside style={s.side}>
          <div style={s.sideHead}>
            <div style={s.sideHeadText}>
              <div style={s.label}>{t("label")}</div>
              {list && globs && (
                <div className="mono" style={s.globs}>
                  {globs}
                </div>
              )}
              {list && list.clone_status === "ready" && (
                <div className="tnum" style={s.summary}>
                  {t("summary", { count: docs.length, tokens: list.tokens_total })}
                </div>
              )}
            </div>
            <IconBtn icon="RefreshCw" label={t("refresh")} onClick={refresh} />
          </div>

          {isLoading && (
            <div style={s.rows}>
              <Skeleton height={34} />
              <Skeleton height={34} />
              <Skeleton height={34} />
            </div>
          )}
          {isError && (
            <ErrorState title={tc("states.error")} body={t("loadError")} onRetry={() => refetch()} retryLabel={tc("actions.retry")} />
          )}
          {list?.clone_status === "not_cloned" && (
            <EmptyState icon="Folder" title={t("notCloned.title")} body={t("notCloned.body")} />
          )}
          {list?.clone_status === "ready" && docs.length === 0 && (
            <EmptyState icon="FileText" title={t("empty.title", { globs })} body={t("empty.body", { globs })} />
          )}
          {docs.length > 0 && (
            <>
              <TextInput value={query} onChange={setQuery} placeholder={t("filterPlaceholder")} aria-label={t("filterLabel")} />
              {list?.truncated && <p style={s.muted}>{t("truncated", { count: docs.length })}</p>}
              {visible.length === 0 ? (
                <p style={s.muted}>{t("noMatch")}</p>
              ) : (
                <DocList docs={visible} selected={doc} onSelect={select} />
              )}
            </>
          )}
        </aside>
        <DocPreviewPane repoId={repoId} path={doc} />
      </div>
    </AppShell>
  );
}
