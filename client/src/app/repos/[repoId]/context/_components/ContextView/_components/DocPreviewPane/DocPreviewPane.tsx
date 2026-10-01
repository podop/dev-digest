/* DocPreviewPane — the selected document rendered as markdown (view-only) with
   its token estimate and "Used by N agents". Raw HTML in a document is printed
   as text by the vendored <Markdown>, never executed. */
"use client";

import { useTranslations } from "next-intl";
import { Badge, EmptyState, ErrorState, Icon, Markdown, Skeleton } from "@devdigest/ui";
import { ApiError } from "@/lib/api";
import { useContextDoc } from "@/lib/hooks";
import { s } from "./styles";

/** The API codes a preview can end with, mapped to their message key. */
const ERROR_KEYS: Record<number, "notFound" | "tooLarge" | "invalidPath"> = {
  404: "notFound",
  413: "tooLarge",
  400: "invalidPath",
};

export function DocPreviewPane({ repoId, path }: { repoId: string; path: string | null }) {
  const t = useTranslations("context");
  const tc = useTranslations("common");
  const { data: doc, isLoading, isError, error, refetch } = useContextDoc(repoId, path);

  if (!path) {
    return (
      <div style={s.pane}>
        <EmptyState icon="FileText" title={t("preview.select")} body={t("preview.selectBody")} />
      </div>
    );
  }
  if (isLoading) {
    return (
      <div style={s.pane}>
        <div style={s.center}>
          <Skeleton height={28} width="40%" />
          <Skeleton height={14} style={{ marginTop: 20 }} />
          <Skeleton height={14} width="80%" style={{ marginTop: 10 }} />
          <Skeleton height={14} width="65%" style={{ marginTop: 10 }} />
        </div>
      </div>
    );
  }
  if (isError || !doc) {
    const key = error instanceof ApiError ? ERROR_KEYS[error.status] : undefined;
    return (
      <div style={s.pane}>
        <ErrorState
          title={tc("states.error")}
          body={t(key ? `preview.${key}` : "preview.loadError")}
          onRetry={() => refetch()}
          retryLabel={tc("actions.retry")}
        />
      </div>
    );
  }

  const usedByTitle = doc.used_by_agents
    .map((a) =>
      a.via === "skill"
        ? t("preview.usedBySkill", { name: a.name, skill: a.skill_name ?? "" })
        : t("preview.usedByDirect", { name: a.name }),
    )
    .join("\n");

  return (
    <div style={s.pane}>
      <div style={s.header}>
        <h2 className="mono" style={s.title} title={doc.path}>
          {doc.name}
        </h2>
        <Badge>{t(`docType.${doc.doc_type}`)}</Badge>
        <div style={s.meta}>
          <span className="tnum">{t("preview.tokens", { tokens: doc.tokens })}</span>
          <span style={s.usedBy} title={usedByTitle || undefined}>
            <Icon.Cpu size={14} />
            {t("preview.usedBy", { count: doc.used_by })}
          </span>
        </div>
      </div>
      <div style={s.body}>
        <Markdown>{doc.content}</Markdown>
      </div>
    </div>
  );
}
