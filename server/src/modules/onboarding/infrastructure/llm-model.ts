/**
 * OnboardingModel over the workspace's `onboarding` feature model (Settings →
 * Feature models) and the container's LLM providers. It also owns the error
 * mapping of FR1: a missing provider key is a 422 the UI can act on, every
 * other failure (provider error, invalid output after the retry, abort) a 502.
 */
import type { ChatMessage, FeatureModelChoice, LLMProvider, Provider } from '@devdigest/shared';
import { ConfigError, ExternalServiceError, ValidationError } from '../../../platform/errors.js';
import type { GenerateResult, OnboardingModel, ResolvedModel } from '../application/ports.js';
import { LLM_MAX_OUTPUT_TOKENS, LLM_MAX_RETRIES, ONBOARDING_SCHEMA_NAME } from '../domain/constants.js';
import { OnboardingLlmOutput } from '../domain/prompt.js';

export interface LlmOnboardingModelDeps {
  resolveModel: (workspaceId: string) => Promise<FeatureModelChoice>;
  llm: (provider: Provider) => Promise<LLMProvider>;
}

export class LlmOnboardingModel implements OnboardingModel {
  constructor(private readonly deps: LlmOnboardingModelDeps) {}

  async resolve(workspaceId: string): Promise<ResolvedModel> {
    const choice = await this.deps.resolveModel(workspaceId);
    return { provider: choice.provider, model: choice.model };
  }

  async generate(resolved: ResolvedModel, messages: ChatMessage[], signal: AbortSignal): Promise<GenerateResult> {
    try {
      const llm = await this.deps.llm(resolved.provider);
      const res = await llm.completeStructured({
        model: resolved.model,
        schema: OnboardingLlmOutput,
        schemaName: ONBOARDING_SCHEMA_NAME,
        messages,
        temperature: 0.2,
        maxTokens: LLM_MAX_OUTPUT_TOKENS,
        maxRetries: LLM_MAX_RETRIES,
        signal,
      });
      return { data: res.data, tokensIn: res.tokensIn, tokensOut: res.tokensOut, costUsd: res.costUsd };
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new ValidationError(
          `The ${resolved.provider} provider is not configured`,
          { provider: resolved.provider },
          'provider_not_configured',
        );
      }
      // The provider's message may echo repo content: the response stays generic.
      throw new ExternalServiceError('The model call failed', undefined, 'generation_failed');
    }
  }
}
