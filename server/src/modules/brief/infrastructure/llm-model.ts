/**
 * BriefModel over the workspace's `risk_brief` feature model (Settings → Feature
 * models) and the container's LLM providers. It owns the error mapping: a missing
 * provider key is a 422 the UI can act on, every other failure (provider error,
 * invalid output after the re-ask, abort) a 502.
 */
import type { ChatMessage, FeatureModelChoice, LLMProvider, Provider } from '@devdigest/shared';
import { ConfigError, ExternalServiceError, ValidationError } from '../../../platform/errors.js';
import type { BriefModel, GenerateResult, ModelUsage, ResolvedModel } from '../application/ports.js';
import { BRIEF_SCHEMA_NAME, LLM_MAX_OUTPUT_TOKENS, LLM_MAX_RETRIES } from '../domain/constants.js';
import { BriefLlmOutput } from '../domain/prompt.js';

export interface LlmBriefModelDeps {
  resolveModel: (workspaceId: string) => Promise<FeatureModelChoice>;
  llm: (provider: Provider) => Promise<LLMProvider>;
}

export class LlmBriefModel implements BriefModel {
  constructor(private readonly deps: LlmBriefModelDeps) {}

  async resolve(workspaceId: string): Promise<ResolvedModel> {
    const choice = await this.deps.resolveModel(workspaceId);
    return { provider: choice.provider, model: choice.model };
  }

  async generate(
    resolved: ResolvedModel,
    messages: ChatMessage[],
    signal: AbortSignal,
    onUsage: (usage: ModelUsage) => void,
  ): Promise<GenerateResult> {
    try {
      const llm = await this.deps.llm(resolved.provider);
      const res = await llm.completeStructured({
        model: resolved.model,
        schema: BriefLlmOutput,
        schemaName: BRIEF_SCHEMA_NAME,
        messages,
        temperature: 0.2,
        maxTokens: LLM_MAX_OUTPUT_TOKENS,
        maxRetries: LLM_MAX_RETRIES,
        onUsage,
        signal,
      });
      return { data: res.data, tokensIn: res.tokensIn, tokensOut: res.tokensOut, costUsd: res.costUsd, attempts: res.attempts };
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new ValidationError(
          `The ${resolved.provider} provider is not configured`,
          { provider: resolved.provider },
          'provider_not_configured',
        );
      }
      // The provider's message may echo PR content: the response stays generic.
      throw new ExternalServiceError('The model call failed', undefined, 'generation_failed');
    }
  }
}
