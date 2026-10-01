/* PriorPrs — "Prior PRs touching these files" (client/specs/07-blast-radius.md,
   P3): a collapsible list with a count badge. Each row: #number + title (a
   github.com link built from the PR's own repo), author, merge date and the
   overlapping files. Rendered only when there is something to show: a loading,
   failed or empty history leaves no trace in the card. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon } from "@devdigest/ui";
import { usePrHistory } from "@/lib/hooks/blast";
import { githubPrUrl } from "@/lib/github-urls";
import { FILES_SHOWN } from "./constants";
import { s } from "./styles";

export interface PriorPrsProps {
  prId: string;
  repoFullName: string | null;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function PriorPrs({ prId, repoFullName }: PriorPrsProps) {
  const t = useTranslations("blast");
  const { data } = usePrHistory(prId);
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();

  const items = data?.history ?? [];
  if (items.length === 0) return null;

  const Chevron = open ? Icon.ChevronDown : Icon.ChevronRight;
  return (
    <div style={s.root}>
      <button type="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)} style={s.toggle}>
        <Chevron size={14} style={s.chevron} />
        <span>{t("priorPrs.title")}</span>
        <Badge>{items.length}</Badge>
      </button>
      {open && (
        <ul id={listId} style={s.list}>
          {items.map((pr) => (
            <li key={pr.pr_number} style={s.row}>
              <div style={s.titleLine}>
                <span className="mono" style={s.meta}>
                  #{pr.pr_number}
                </span>
                {repoFullName ? (
                  <a href={githubPrUrl(repoFullName, pr.pr_number)} target="_blank" rel="noopener noreferrer" style={s.link}>
                    {pr.title}
                  </a>
                ) : (
                  <span style={s.plain}>{pr.title}</span>
                )}
              </div>
              <div style={s.meta}>
                {t("priorPrs.meta", { author: pr.author, date: formatWhen(pr.merged_at) })}
              </div>
              <ul style={s.files} aria-label={t("priorPrs.files", { count: pr.files_overlap.length })}>
                {pr.files_overlap.slice(0, FILES_SHOWN).map((f) => (
                  <li key={f} className="mono">
                    {f}
                  </li>
                ))}
                {pr.files_overlap.length > FILES_SHOWN && (
                  <li title={pr.files_overlap.join("\n")} style={s.meta}>
                    {t("priorPrs.moreFiles", { count: pr.files_overlap.length - FILES_SHOWN })}
                  </li>
                )}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
