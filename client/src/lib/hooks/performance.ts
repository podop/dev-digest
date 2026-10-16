/* hooks/performance.ts — React Query hooks of the Agent Performance dashboard and the agent
   Stats tab (specs/2026-10-16-agent-performance.md §7). Read-only GETs: the query key carries
   the URL period, the ISO instants are built in the queryFn, so a period change is a new key
   (no placeholder data — the old period's numbers are never shown) and nothing polls. */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { AgentPerf, AgentStats } from "@devdigest/shared";
import { api } from "../api";
import { periodApiQuery, periodSearch, type StatsPeriod } from "../stats-period";
import { performanceKeys } from "./keys";

/** GET /agents/performance — one row per agent for the period. */
export function useAgentPerformance(period: StatsPeriod) {
  return useQuery({
    queryKey: performanceKeys.dashboard(periodSearch(period)),
    queryFn: () => api.get<AgentPerf>(`/agents/performance?${periodApiQuery(period)}`),
  });
}

/** GET /agents/:id/stats — the same aggregation for one agent. */
export function useAgentStats(agentId: string | null | undefined, period: StatsPeriod) {
  return useQuery({
    queryKey: performanceKeys.agentStats(agentId, periodSearch(period)),
    queryFn: () => api.get<AgentStats>(`/agents/${encodeURIComponent(agentId ?? "")}/stats?${periodApiQuery(period)}`),
    enabled: !!agentId,
  });
}
