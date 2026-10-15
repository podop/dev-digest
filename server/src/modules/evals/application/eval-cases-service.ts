/**
 * Eval case use cases (FR1–FR5): create from a decided finding, list per agent,
 * edit name / notes / lines, delete. Workspace-scoped; a foreign id is a 404.
 */
import { EVAL_CASES_PER_AGENT_MAX } from '@devdigest/shared';
import type { AgentEvalCase, AgentEvalCaseUpdateInput } from '@devdigest/shared';
import { ConflictError, NotFoundError, ValidationError } from '../../../platform/errors.js';
import { buildEvalCase, editExpectationLines } from '../domain/case-builder.js';
import type { EvalCaseWrite } from '../domain/types.js';
import type { AgentDirectory, EvalCasesStore, EvalCasesTx } from './ports.js';

export interface EvalCasesServiceDeps {
  cases: EvalCasesStore;
  tx: EvalCasesTx;
  agents: AgentDirectory;
}

const CASE_NOT_FOUND = 'Eval case not found';

/** 409 `eval_case_exists`, carrying the id of the existing case. */
function caseExists(caseId: string): ConflictError {
  return new ConflictError('An eval case already exists for this finding', { case_id: caseId }, 'eval_case_exists');
}

export class EvalCasesService {
  constructor(private readonly deps: EvalCasesServiceDeps) {}

  /** FR1–FR3: snapshot a decided finding as the agent's case; a second call is a 409 with the existing id. */
  async createFromFinding(workspaceId: string, findingId: string): Promise<AgentEvalCase> {
    const { cases } = this.deps;
    const source = await cases.findingSource(workspaceId, findingId);
    if (!source) throw new NotFoundError('Finding not found');

    const existing = await cases.caseIdForFinding(workspaceId, findingId);
    if (existing) throw caseExists(existing);

    const values = buildEvalCase(workspaceId, source);
    if ((await cases.count(workspaceId, values.agentId)) >= EVAL_CASES_PER_AGENT_MAX) {
      throw new ValidationError(
        `An agent can have at most ${EVAL_CASES_PER_AGENT_MAX} eval cases`,
        undefined,
        'eval_case_limit',
      );
    }
    const result = await cases.insert(values);
    if (result.kind === 'exists') throw caseExists(result.caseId);
    return result.case;
  }

  async list(workspaceId: string, agentId: string): Promise<AgentEvalCase[]> {
    if (!(await this.deps.agents.exists(workspaceId, agentId))) throw new NotFoundError('Agent not found');
    return this.deps.cases.list(workspaceId, agentId);
  }

  /** FR5: name, notes and lines; `end_line >= start_line` is checked against the stored lines (EC16). */
  update(workspaceId: string, id: string, input: AgentEvalCaseUpdateInput): Promise<AgentEvalCase> {
    return this.deps.tx.run(async ({ cases }) => {
      const stored = await cases.lockForUpdate(workspaceId, id);
      if (!stored) throw new NotFoundError(CASE_NOT_FOUND);
      const values: EvalCaseWrite = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.start_line !== undefined || input.end_line !== undefined
          ? { expectation: editExpectationLines(stored.expectation, input) }
          : {}),
      };
      return cases.update(workspaceId, id, values);
    });
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    if (!(await this.deps.cases.delete(workspaceId, id))) throw new NotFoundError(CASE_NOT_FOUND);
  }
}
