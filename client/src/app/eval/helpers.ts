/** Normalize a raw ?agent= value (missing, empty or repeated → the first non-empty value, else null). */
export function resolveAgentId(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ? value : null;
}

/** Eval Dashboard URL: all agents, or one agent's view. */
export function evalHref(agentId?: string | null): string {
  return agentId ? `/eval?${new URLSearchParams({ agent: agentId }).toString()}` : "/eval";
}

/** The agent editor's Evals tab. */
export function agentEvalsHref(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}?tab=evals`;
}
