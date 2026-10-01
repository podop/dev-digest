import type { FastifyRequest } from 'fastify';
import type { Container } from '../../platform/container.js';

export interface RequestContext {
  workspaceId: string;
  userId: string;
}

/**
 * Resolve the tenancy context for a request via the AuthProvider. In MVP
 * (LocalNoAuthProvider) this always returns the default workspace + system user.
 * Every module uses this so workspace scoping is never forgotten.
 *
 * The result is frozen: route handlers must not mutate the tenancy context.
 */
export async function getContext(
  container: Container,
  req: FastifyRequest,
): Promise<RequestContext> {
  const [user, workspace] = await Promise.all([
    container.auth.currentUser(req),
    container.auth.currentWorkspace(req),
  ]);
  return Object.freeze({ workspaceId: workspace.id, userId: user.id });
}
