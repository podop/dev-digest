/**
 * Eval case use cases (FR1–FR6): create from a decided finding or from scratch (agent or
 * skill owner), list per owner, edit any field, delete. Workspace-scoped; a foreign id is a
 * 404. Content checks are deterministic domain code — no LLM call is made here.
 */
import { EVAL_CASES_PER_AGENT_MAX } from '@devdigest/shared';
import type { AgentEvalCase, AgentEvalCaseUpdateInput, EvalCaseCreateInput } from '@devdigest/shared';
import { ConflictError, NotFoundError, ValidationError } from '../../../platform/errors.js';
import { buildEvalCase } from '../domain/case-builder.js';
import { buildManualCase, checkCaseContent, mergeCaseEdit, normalizeCaseDiff } from '../domain/case-input.js';
import type { CaseOwner } from '../domain/types.js';
import type { AgentDirectory, DiffParser, EvalCasesStore, EvalCasesTx, EvalLogger, SkillDirectory } from './ports.js';

export interface EvalCasesServiceDeps {
  cases: EvalCasesStore;
  tx: EvalCasesTx;
  agents: AgentDirectory;
  skills: SkillDirectory;
  parseDiff: DiffParser;
}

const CASE_NOT_FOUND = 'Eval case not found';

/** 409 `eval_case_exists`, carrying the id of the existing case. */
function caseExists(caseId: string): ConflictError {
  return new ConflictError('An eval case already exists for this finding', { case_id: caseId }, 'eval_case_exists');
}

export class EvalCasesService {
  constructor(private readonly deps: EvalCasesServiceDeps) {}

  /** 404 unless the owner (agent or skill) belongs to the workspace. */
  private async assertOwner(workspaceId: string, owner: CaseOwner): Promise<void> {
    const found =
      owner.kind === 'agent'
        ? await this.deps.agents.exists(workspaceId, owner.id)
        : (await this.deps.skills.get(workspaceId, owner.id)) !== undefined;
    if (!found) throw new NotFoundError(owner.kind === 'agent' ? 'Agent not found' : 'Skill not found');
  }

  /** The 201st case of an owner is rejected (`eval_case_limit`); count-then-insert, not atomic. */
  private async assertUnderLimit(workspaceId: string, owner: CaseOwner): Promise<void> {
    if ((await this.deps.cases.count(workspaceId, owner)) >= EVAL_CASES_PER_AGENT_MAX) {
      throw new ValidationError(
        `An agent or skill can have at most ${EVAL_CASES_PER_AGENT_MAX} eval cases`,
        undefined,
        'eval_case_limit',
      );
    }
  }

  /** One info line per created case: ids and the diff length, never the diff or any PR text (NFR3). */
  private logCreated(log: EvalLogger, created: AgentEvalCase): void {
    log.info(
      {
        caseId: created.id,
        ownerKind: created.owner_kind,
        ownerId: created.owner_id,
        diffLength: created.input_diff.length,
      },
      'eval case created',
    );
  }

  /** FR1–FR3 of the eval pipeline: snapshot a decided finding as the agent's case; a second call is a 409 with the existing id. */
  async createFromFinding(workspaceId: string, findingId: string, log: EvalLogger): Promise<AgentEvalCase> {
    const { cases } = this.deps;
    const source = await cases.findingSource(workspaceId, findingId);
    if (!source) throw new NotFoundError('Finding not found');

    const existing = await cases.caseIdForFinding(workspaceId, findingId);
    if (existing) throw caseExists(existing);

    const values = buildEvalCase(workspaceId, source);
    await this.assertUnderLimit(workspaceId, { kind: values.ownerKind, id: values.ownerId });
    const result = await cases.insert(values);
    if (result.kind === 'exists') throw caseExists(result.caseId);
    this.logCreated(log, result.case);
    return result.case;
  }

  /** FR1–FR4: a case written from scratch for an agent or a skill. */
  async create(
    workspaceId: string,
    owner: CaseOwner,
    input: EvalCaseCreateInput,
    log: EvalLogger,
  ): Promise<AgentEvalCase> {
    await this.assertOwner(workspaceId, owner);
    const diff = normalizeCaseDiff(input.input_diff, input.expectation.file);
    checkCaseContent(diff, input.expectation, this.deps.parseDiff);
    await this.assertUnderLimit(workspaceId, owner);
    const result = await this.deps.cases.insert(buildManualCase(workspaceId, owner, input, diff));
    // Only a case from a finding can lose the one-case-per-finding race.
    if (result.kind === 'exists') throw caseExists(result.caseId);
    this.logCreated(log, result.case);
    return result.case;
  }

  async list(workspaceId: string, owner: CaseOwner): Promise<AgentEvalCase[]> {
    await this.assertOwner(workspaceId, owner);
    return this.deps.cases.list(workspaceId, owner);
  }

  /**
   * FR6, FR15: edit any field of any case. The merged content is re-checked when the edit
   * carries the diff, the file or the lines (D5/EC14); a merged `end_line < start_line` is a 400.
   */
  update(workspaceId: string, id: string, input: AgentEvalCaseUpdateInput): Promise<AgentEvalCase> {
    return this.deps.tx.run(async ({ cases }) => {
      const stored = await cases.lockForUpdate(workspaceId, id);
      if (!stored) throw new NotFoundError(CASE_NOT_FOUND);
      const { values, recheck } = mergeCaseEdit(stored, input);
      if (recheck) {
        checkCaseContent(
          values.inputDiff ?? stored.inputDiff,
          values.expectation ?? stored.expectation,
          this.deps.parseDiff,
        );
      }
      return cases.update(workspaceId, id, values);
    });
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    if (!(await this.deps.cases.delete(workspaceId, id))) throw new NotFoundError(CASE_NOT_FOUND);
  }
}
