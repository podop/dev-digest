/* BlastTree — one collapsible row per changed symbol that has callers (chevron,
   `<> name()`, "N callers"); expanded it lists each caller as a GitHub deep-link
   to its line, then the endpoint chips (globe) and — styled apart — the cron chips
   (amber clock). The first symbol starts open. The row is a real
   <button aria-expanded>; the links live in the panel, never inside it. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon } from "@devdigest/ui";
import type { BlastCaller, DownstreamImpact } from "@devdigest/shared";
import { callerSymbolLabel } from "../../helpers";
import { s } from "./styles";

export interface BlastTreeProps {
  downstream: DownstreamImpact[];
  /** Deep-link of a caller's line; undefined renders plain text. */
  callerHref: (caller: BlastCaller) => string | undefined;
}

export function BlastTree({ downstream, callerHref }: BlastTreeProps) {
  const t = useTranslations("blast");
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set(downstream[0] ? [downstream[0].symbol] : []));
  const baseId = React.useId();

  const toggle = (symbol: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(symbol)) next.add(symbol);
      return next;
    });

  return (
    <ul style={s.list}>
      {downstream.map((d, i) => {
        const isOpen = open.has(d.symbol);
        const panelId = `${baseId}-${i}`;
        const Chevron = isOpen ? Icon.ChevronDown : Icon.ChevronRight;
        return (
          <li key={d.symbol} style={s.item}>
            <button type="button" aria-expanded={isOpen} aria-controls={panelId} onClick={() => toggle(d.symbol)} style={s.row}>
              <Chevron size={14} style={s.chevron} />
              <Icon.Code size={14} style={s.codeIcon} />
              <span className="mono" style={s.symbol}>
                {d.symbol}()
              </span>
              <span style={s.count}>{t("callerCount", { count: d.callers.length })}</span>
            </button>
            {isOpen && (
              <div id={panelId} style={s.panel}>
                <ul style={s.callers} aria-label={t("callers")}>
                  {d.callers.map((c) => {
                    const href = callerHref(c);
                    const where = `${c.file}:${c.line}`;
                    const symbol = callerSymbolLabel(c);
                    return (
                      <li key={`${c.file}:${c.line}:${c.name}`} style={s.caller}>
                        {symbol && (
                          <span className="mono" style={s.callerName}>
                            {symbol}
                          </span>
                        )}
                        {href ? (
                          <a className="mono" href={href} target="_blank" rel="noopener noreferrer" style={s.link}>
                            {where}
                          </a>
                        ) : (
                          <span className="mono" style={s.plain}>
                            {where}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {d.endpoints_affected.length > 0 && (
                  <ul style={s.chips} aria-label={t("endpointsAffected")}>
                    {d.endpoints_affected.map((e) => (
                      <li key={e}>
                        <Badge icon="Globe" mono>
                          {e}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
                {d.crons_affected.length > 0 && (
                  <ul style={s.chips} aria-label={t("cronsAffected")}>
                    {d.crons_affected.map((c) => (
                      <li key={c}>
                        <Badge icon="Clock" mono color="var(--warn)" bg="var(--warn-bg)">
                          {c}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
