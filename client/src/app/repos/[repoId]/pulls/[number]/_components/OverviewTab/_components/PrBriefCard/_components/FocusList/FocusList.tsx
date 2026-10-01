/* FocusList — "Review focus — read these first": the model's items in stored (reading)
   order, numbered, with a count badge. An item opens Files changed at its file and line;
   a file outside the PR's diff gets an inline message instead. Plain text only. */
"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@devdigest/ui";
import type { ReviewFocusItem } from "@devdigest/shared";
import type { OpenInDiff } from "../../useOpenInDiff";
import { s } from "./styles";

export interface FocusListProps extends OpenInDiff {
  items: readonly ReviewFocusItem[];
}

export function FocusList({ items, open, missingKey }: FocusListProps) {
  const t = useTranslations("brief");
  return (
    <section style={s.section}>
      <div style={s.headingRow}>
        <h3 style={s.heading}>{t("focus.title")}</h3>
        {items.length > 0 && <Badge>{items.length}</Badge>}
      </div>
      {items.length === 0 ? (
        <p style={s.empty}>{t("focus.empty")}</p>
      ) : (
        <ol style={s.list}>
          {items.map((item, i) => {
            const ref = `${item.file}:${item.line}`;
            const key = `focus:${i}:${ref}`;
            return (
              <li key={key} style={s.item}>
                <span aria-hidden="true" style={s.number}>
                  {i + 1}
                </span>
                <div style={s.body}>
                  <button
                    type="button"
                    className="mono"
                    style={s.ref}
                    title={ref}
                    onClick={() => open(key, { file: item.file, start_line: item.line, end_line: null })}
                  >
                    {ref}
                  </button>
                  <span style={s.reason}>{item.reason}</span>
                  {missingKey === key && <span style={s.notInDiff}>{t("notInDiff")}</span>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
