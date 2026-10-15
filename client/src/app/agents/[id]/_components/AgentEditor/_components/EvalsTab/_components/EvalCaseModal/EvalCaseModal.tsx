/* EvalCaseModal — view and edit one eval case (FR22): name, notes and the line range
   are editable; kind, file, severity, category, title, the input diff, PR meta and the
   latest result are read-only. Everything is shown as plain text — diffs, PR meta and
   finding titles are PR-author-steerable (NFR7). A save error stays inline. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Modal, Textarea, TextInput } from "@devdigest/ui";
import type { AgentEvalCase } from "@devdigest/shared";
import { useUpdateEvalCase } from "@/lib/hooks";
import { buildPatch, formatDate, formValues, saveErrorKey, validate, type CaseDraft } from "./helpers";
import { s } from "./styles";

export function EvalCaseModal({
  evalCase,
  onClose,
  onDelete,
}: {
  evalCase: AgentEvalCase;
  onClose: () => void;
  /** Hands the case to the parent's delete confirmation. */
  onDelete: () => void;
}) {
  const t = useTranslations("eval.caseModal");
  const tc = useTranslations("common");
  const update = useUpdateEvalCase();
  const [draft, setDraft] = React.useState<CaseDraft>({});

  const values = formValues(evalCase, draft);
  const validity = validate(values);
  const patch = validity.nameOk && validity.linesOk ? buildPatch(evalCase, values) : null;
  const edit = (field: keyof CaseDraft) => (value: string) => setDraft((d) => ({ ...d, [field]: value }));

  const save = () => {
    if (patch) update.mutate({ id: evalCase.id, patch }, { onSuccess: onClose });
  };

  const { expectation, input_meta: meta, last_result: last } = evalCase;
  const none = t("noValue");

  return (
    <Modal
      width={760}
      title={t("title")}
      subtitle={evalCase.name}
      onClose={onClose}
      footer={
        <div style={s.footer}>
          {update.isError && (
            <span role="alert" style={s.error}>
              {t(`saveError.${saveErrorKey(update.error)}`)}
            </span>
          )}
          <Button kind="danger" icon="Trash" onClick={onDelete} disabled={update.isPending}>
            {t("delete")}
          </Button>
          <span style={s.spacer} />
          <Button kind="ghost" onClick={onClose}>
            {tc("actions.cancel")}
          </Button>
          <Button kind="primary" onClick={save} disabled={!patch} loading={update.isPending}>
            {update.isPending ? t("saving") : t("save")}
          </Button>
        </div>
      }
    >
      <div style={s.body}>
        <label style={s.field}>
          <span style={s.label}>{t("name")}</span>
          <TextInput value={values.name} onChange={edit("name")} />
        </label>
        <label style={s.field}>
          <span style={s.label}>{t("notes")}</span>
          <Textarea value={values.notes} onChange={edit("notes")} rows={3} placeholder={t("notesPlaceholder")} />
        </label>

        <section aria-label={t("expectationHeading")} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h3 style={s.heading}>{t("expectationHeading")}</h3>
          <dl style={s.facts}>
            <Fact term={t("kind")} value={t(`kindValue.${expectation.kind}`)} />
            <Fact term={t("file")} value={expectation.file} mono />
            <Fact term={t("severity")} value={expectation.severity ?? none} />
            <Fact term={t("category")} value={expectation.category ?? none} />
            <Fact term={t("findingTitle")} value={expectation.title ?? none} />
          </dl>
          <div style={s.row}>
            <label style={s.field}>
              <span style={s.label}>{t("startLine")}</span>
              <TextInput type="number" min={1} value={values.startLine} onChange={edit("startLine")} />
            </label>
            <label style={s.field}>
              <span style={s.label}>{t("endLine")}</span>
              <TextInput type="number" min={1} value={values.endLine} onChange={edit("endLine")} />
            </label>
          </div>
          {validity.rangeInverted && (
            <span role="alert" style={s.invalid}>
              {t("linesInvalid")}
            </span>
          )}
        </section>

        <section aria-label={t("inputHeading")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h3 style={s.heading}>{t("inputHeading")}</h3>
          <pre className="mono" style={s.diff} tabIndex={0}>
            {evalCase.input_diff}
          </pre>
        </section>

        <section aria-label={t("metaHeading")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h3 style={s.heading}>{t("metaHeading")}</h3>
          <dl style={s.facts}>
            <Fact term={t("prTitle")} value={meta.pr_title} />
            <Fact term={t("prDescription")} value={meta.pr_description ?? none} />
            <Fact term={t("repo")} value={meta.repo} mono />
            <Fact term={t("prNumber")} value={String(meta.pr_number)} />
            <Fact term={t("headSha")} value={meta.head_sha ?? none} mono />
          </dl>
        </section>

        <section aria-label={t("lastResultHeading")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h3 style={s.heading}>{t("lastResultHeading")}</h3>
          <span style={{ fontSize: 13 }}>
            {last ? t("lastResult", { status: t(`status.${last.status}`), date: formatDate(last.ran_at) }) : t("neverRun")}
          </span>
        </section>
      </div>
    </Modal>
  );
}

function Fact({ term, value, mono }: { term: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt style={s.term}>{term}</dt>
      <dd className={mono ? "mono" : undefined} style={s.def}>
        {value}
      </dd>
    </>
  );
}
