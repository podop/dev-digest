import type { AgentEvalCase, AgentEvalCaseUpdateInput } from "@devdigest/shared";
import { ApiError } from "@/lib/api";

/** Mirrors EVAL_CASE_NAME_MAX of the eval-pipeline contract (a runtime import would pull zod into the route). */
export const NAME_MAX = 120;

/** Touched fields only; line inputs stay strings while the user types. */
export interface CaseDraft {
  name?: string;
  notes?: string;
  startLine?: string;
  endLine?: string;
}

export interface CaseFormValues {
  name: string;
  notes: string;
  startLine: string;
  endLine: string;
}

/** Draft over the stored case. */
export function formValues(c: AgentEvalCase, draft: CaseDraft): CaseFormValues {
  return {
    name: draft.name ?? c.name,
    notes: draft.notes ?? c.notes ?? "",
    startLine: draft.startLine ?? String(c.expectation.start_line),
    endLine: draft.endLine ?? String(c.expectation.end_line),
  };
}

/** A positive whole line number, else null. */
export function parseLine(value: string): number | null {
  const n = Number(value);
  return value.trim() !== "" && Number.isInteger(n) && n >= 1 ? n : null;
}

export interface CaseValidity {
  nameOk: boolean;
  linesOk: boolean;
  /** Lines are numbers but end < start. */
  rangeInverted: boolean;
}

export function validate(values: CaseFormValues): CaseValidity {
  const name = values.name.trim();
  const start = parseLine(values.startLine);
  const end = parseLine(values.endLine);
  const linesOk = start != null && end != null && end >= start;
  return {
    nameOk: name.length >= 1 && name.length <= NAME_MAX,
    linesOk,
    rangeInverted: start != null && end != null && end < start,
  };
}

/** PATCH body with the changed fields only (both lines together when either moved);
 *  null when nothing changed. Assumes `validate` passed. */
export function buildPatch(c: AgentEvalCase, values: CaseFormValues): AgentEvalCaseUpdateInput | null {
  const patch: AgentEvalCaseUpdateInput = {};
  const name = values.name.trim();
  if (name !== c.name) patch.name = name;
  const notes = values.notes.trim() === "" ? null : values.notes;
  if (notes !== c.notes) patch.notes = notes;
  const start = parseLine(values.startLine);
  const end = parseLine(values.endLine);
  if (start !== c.expectation.start_line || end !== c.expectation.end_line) {
    if (start != null) patch.start_line = start;
    if (end != null) patch.end_line = end;
  }
  return Object.keys(patch).length ? patch : null;
}

export type SaveErrorKey = "validation" | "notFound" | "generic";

export function saveErrorKey(err: unknown): SaveErrorKey {
  if (err instanceof ApiError) {
    if (err.code === "validation_error") return "validation";
    if (err.code === "not_found" || err.status === 404) return "notFound";
  }
  return "generic";
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
