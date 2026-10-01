/* RiskList — Risk areas: one row per risk (severity icon + text, title, file refs); the row
   head is a button that expands the explanation. A file ref opens Files changed at that
   line. All text is rendered as plain text. */
"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { Risk } from "@devdigest/shared";
import { parseFileRef } from "../../helpers";
import type { OpenInDiff } from "../../useOpenInDiff";
import { SEVERITY_META } from "./constants";
import { s } from "./styles";

export interface RiskListProps extends OpenInDiff {
  risks: readonly Risk[];
}

/** Unique per risk within one brief (the model returns no ids): the position keeps identical risks apart. */
const riskId = (r: Risk, i: number) => `risk:${i}:${r.severity}:${r.title}:${r.file_refs.join(",")}`;

export function RiskList({ risks, open, missingKey }: RiskListProps) {
  const t = useTranslations("brief");
  return (
    <section style={s.section}>
      <h3 style={s.heading}>{t("block.risks")}</h3>
      {risks.length === 0 ? (
        <p style={s.empty}>{t("noRisks")}</p>
      ) : (
        <ul style={s.list}>
          {risks.map((risk, i) => {
            const id = riskId(risk, i);
            return <RiskRow key={id} id={id} risk={risk} open={open} missingKey={missingKey} />;
          })}
        </ul>
      )}
    </section>
  );
}

function RiskRow({ id, risk, open, missingKey }: { id: string; risk: Risk } & OpenInDiff) {
  const t = useTranslations("brief");
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const meta = SEVERITY_META[risk.severity];
  const SevIcon = Icon[meta.icon];
  return (
    <li style={s.row}>
      <button type="button" style={s.head} aria-expanded={expanded} aria-controls={expanded ? panelId : undefined} onClick={() => setExpanded((v) => !v)}>
        <SevIcon size={16} style={s.icon(meta.color)} aria-hidden="true" />
        <span style={s.title}>{risk.title}</span>
        <span style={s.severity(meta.color)}>{t(`risk.severity.${risk.severity}`)}</span>
        <Icon.ChevronDown size={14} style={s.chevron(expanded)} aria-hidden="true" />
      </button>
      <div style={s.refs}>
        {risk.file_refs.map((ref) => {
          const target = parseFileRef(ref);
          return target ? (
            <button key={ref} type="button" className="mono" style={s.ref} title={ref} onClick={() => open(`${id}|${ref}`, target)}>
              {ref}
            </button>
          ) : (
            <span key={ref} className="mono" style={s.refPlain} title={ref}>
              {ref}
            </span>
          );
        })}
        {risk.file_refs.some((ref) => missingKey === `${id}|${ref}`) && <span style={s.notInDiff}>{t("notInDiff")}</span>}
      </div>
      {expanded && (
        <p id={panelId} style={s.explanation}>
          {risk.explanation}
        </p>
      )}
    </li>
  );
}
