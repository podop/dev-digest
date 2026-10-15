import { checkWorkflowDocument, workflowTooLarge, type WorkflowCheck } from '../domain/workflow-rules.js';
import type { YamlCodec } from './ports.js';

/**
 * Check a workflow (generated or edited in the Preview step) against the rule list of spec §7:
 * size limit first, then YAML syntax (both `invalid_yaml`), then the domain rules on the parsed
 * document. Returns the first broken rule.
 */
export function checkWorkflow(text: string, yaml: YamlCodec): WorkflowCheck {
  if (workflowTooLarge(text)) return { ok: false, rule: 'invalid_yaml' };
  let doc: unknown;
  try {
    doc = yaml.parse(text);
  } catch {
    return { ok: false, rule: 'invalid_yaml' };
  }
  return checkWorkflowDocument(doc);
}
