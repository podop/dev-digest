/* hooks/project-context.ts — React Query hooks for Project Context
   (specs/2026-10-01-project-context.md §7): the repo's document list + preview,
   and the per-repo ordered attachments of an agent or a skill. Saves are
   optimistic, roll back on error and run one at a time per owner × repo (EC8). */
"use client";

import { useMutation, useQueries, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { ContextAttachments, ContextAttachmentsInput, ContextDocPreview, ContextList } from "@devdigest/shared";
import { api } from "../api";
import { agentKeys, repoKeys, skillKeys } from "./keys";

const enc = encodeURIComponent;

/** GET /repos/:id/context — the documents of the repo's clone (derived, never stored). */
export function useContextDocs(repoId: string | null | undefined) {
  return useQuery({
    queryKey: repoKeys.context(repoId),
    queryFn: () => api.get<ContextList>(`/repos/${enc(repoId ?? "")}/context`),
    enabled: !!repoId,
  });
}

/** GET /repos/:id/context/doc?path= — one document's content for preview. */
export function useContextDoc(repoId: string | null | undefined, path: string | null | undefined) {
  return useQuery({
    queryKey: repoKeys.contextDoc(repoId, path),
    queryFn: () => api.get<ContextDocPreview>(`/repos/${enc(repoId ?? "")}/context/doc?path=${enc(path ?? "")}`),
    enabled: !!repoId && !!path,
    // A 400/404/413 answer is final for this path; do not hammer the API.
    retry: false,
  });
}

/** Refetches the repo's document list and every preview of it (the refresh action). */
export function useRefreshContext(repoId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: repoKeys.context(repoId) });
}

/** GET /agents/:id/context?repoId= — the agent's ordered attached paths in a repo. */
export function useAgentContext(agentId: string | null | undefined, repoId: string | null | undefined) {
  return useQuery({
    queryKey: agentKeys.context(agentId, repoId),
    queryFn: () => api.get<ContextAttachments>(`/agents/${enc(agentId ?? "")}/context?repoId=${enc(repoId ?? "")}`),
    enabled: !!agentId && !!repoId,
  });
}

/** GET /skills/:id/context?repoId= — the skill's ordered attached paths in a repo. */
export function useSkillContext(skillId: string | null | undefined, repoId: string | null | undefined) {
  return useQuery({
    queryKey: skillKeys.context(skillId, repoId),
    queryFn: () => api.get<ContextAttachments>(`/skills/${enc(skillId ?? "")}/context?repoId=${enc(repoId ?? "")}`),
    enabled: !!skillId && !!repoId,
  });
}

/** The attachments of several skills (an agent's enabled skills) in one repo, keyed by skill id. */
export function useSkillsContext(skillIds: readonly string[], repoId: string | null | undefined) {
  return useQueries({
    queries: skillIds.map((id) => ({
      queryKey: skillKeys.context(id, repoId),
      queryFn: () => api.get<ContextAttachments>(`/skills/${enc(id)}/context?repoId=${enc(repoId ?? "")}`),
      enabled: !!repoId,
    })),
    combine: (results) => ({
      byId: Object.fromEntries(skillIds.map((id, i) => [id, results[i]?.data?.paths ?? []])) as Record<string, string[]>,
      isPending: results.some((r) => r.isPending && r.fetchStatus !== "idle"),
      isError: results.some((r) => r.isError),
    }),
  });
}

/** PUT replaces the whole list; optimistic on `key`, rolled back on error, serial per `scopeId`. */
function useSaveAttachments(opts: { url: string; key: QueryKey; repoId: string; scopeId: string }) {
  const qc = useQueryClient();
  const { url, key, repoId, scopeId } = opts;
  const mutationKey = ["context-save", scopeId] as const;
  /** The newest save of this owner × repo — only it may write the server answer back. */
  const lastIsMine = () => qc.isMutating({ mutationKey }) <= 1;
  return useMutation({
    mutationKey,
    // Mutations of one scope run one after another, so the server sees the
    // saves in click order and its final list equals the last one (EC8).
    scope: { id: scopeId },
    mutationFn: (paths: string[]) => {
      const body: ContextAttachmentsInput = { repo_id: repoId, paths };
      return api.put<ContextAttachments>(url, body);
    },
    onMutate: async (paths) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ContextAttachments>(key);
      qc.setQueryData<ContextAttachments>(key, { repo_id: repoId, paths });
      return { previous };
    },
    onError: (_err, _paths, ctx) => {
      if (lastIsMine() && ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSettled: () => {
      // While another save is queued, a refetch would show a stale list over the newer optimistic one.
      if (!lastIsMine()) return;
      qc.invalidateQueries({ queryKey: key });
      // `used_by` counts of the list and previews change with every attachment.
      qc.invalidateQueries({ queryKey: repoKeys.context(repoId) });
    },
  });
}

/** PUT /agents/:id/context — mutate with the full ordered path list. No agent version bump. */
export function useSetAgentContext(agentId: string, repoId: string) {
  return useSaveAttachments({
    url: `/agents/${enc(agentId)}/context`,
    key: agentKeys.context(agentId, repoId),
    repoId,
    scopeId: `context:agent:${agentId}:${repoId}`,
  });
}

/** PUT /skills/:id/context — mutate with the full ordered path list. No skill version bump. */
export function useSetSkillContext(skillId: string, repoId: string) {
  return useSaveAttachments({
    url: `/skills/${enc(skillId)}/context`,
    key: skillKeys.context(skillId, repoId),
    repoId,
    scopeId: `context:skill:${skillId}:${repoId}`,
  });
}
