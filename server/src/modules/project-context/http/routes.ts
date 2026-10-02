import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getContext } from '../../_shared/context.js';
import { IdParams } from '../../_shared/schemas.js';
import {
  ContextAttachmentsResponse,
  ContextDocResponse,
  ContextListResponse,
  CreateFileBody,
  DocQuery,
  FILE_BODY_LIMIT,
  FileQuery,
  PutContextBody,
  RenameFileBody,
  RepoQuery,
  SaveFileBody,
} from './schemas.js';

/**
 * project-context module (specs/2026-10-01-project-context.md §7).
 *   GET /repos/:id/context              → documents of the clone matching the globs
 *   GET /repos/:id/context/doc?path=    → one document (400 invalid_path · 404 · 413 doc_too_large)
 *   GET|PUT /agents/:id/context         → ordered attached paths of an agent in one repo
 *   GET|PUT /skills/:id/context         → same for a skill
 *   POST /repos/:id/context/files       → create a store file (201; 409 path_exists · 413 · 422)
 *   PUT /repos/:id/context/files?path=  → save a store file at base_version (409 stale_version)
 *   POST /repos/:id/context/files/rename → move a store file, attachments follow (409)
 *   DELETE /repos/:id/context/files?path= → 204; attachments stay (403 read_only for a repo document)
 * Anything from another workspace is a 404, never a 403. Attaching never bumps a version.
 */
export default async function projectContextRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { service, files } = app.container.modules.projectContext;

  app.get(
    '/repos/:id/context',
    { schema: { params: IdParams, response: { 200: ContextListResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.listDocs(workspaceId, req.params.id);
    },
  );

  app.get(
    '/repos/:id/context/doc',
    { schema: { params: IdParams, querystring: DocQuery, response: { 200: ContextDocResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.previewDoc(workspaceId, req.params.id, req.query.path);
    },
  );

  app.get(
    '/agents/:id/context',
    { schema: { params: IdParams, querystring: RepoQuery, response: { 200: ContextAttachmentsResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.getAgentContext(workspaceId, req.params.id, req.query.repoId);
    },
  );

  app.put(
    '/agents/:id/context',
    { schema: { params: IdParams, body: PutContextBody, response: { 200: ContextAttachmentsResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.putAgentContext(workspaceId, req.params.id, req.body);
    },
  );

  app.get(
    '/skills/:id/context',
    { schema: { params: IdParams, querystring: RepoQuery, response: { 200: ContextAttachmentsResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.getSkillContext(workspaceId, req.params.id, req.query.repoId);
    },
  );

  app.put(
    '/skills/:id/context',
    { schema: { params: IdParams, body: PutContextBody, response: { 200: ContextAttachmentsResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.putSkillContext(workspaceId, req.params.id, req.body);
    },
  );

  app.post(
    '/repos/:id/context/files',
    { bodyLimit: FILE_BODY_LIMIT, schema: { params: IdParams, body: CreateFileBody, response: { 201: ContextDocResponse } } },
    async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const created = await files.create(workspaceId, req.params.id, req.body, req.log);
      reply.code(201);
      return created;
    },
  );

  app.put(
    '/repos/:id/context/files',
    {
      bodyLimit: FILE_BODY_LIMIT,
      schema: { params: IdParams, querystring: FileQuery, body: SaveFileBody, response: { 200: ContextDocResponse } },
    },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return files.save(workspaceId, req.params.id, req.query.path, req.body, req.log);
    },
  );

  app.post(
    '/repos/:id/context/files/rename',
    { schema: { params: IdParams, body: RenameFileBody, response: { 200: ContextDocResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return files.rename(workspaceId, req.params.id, req.body, req.log);
    },
  );

  app.delete(
    '/repos/:id/context/files',
    { schema: { params: IdParams, querystring: FileQuery } },
    async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      await files.delete(workspaceId, req.params.id, req.query.path, req.log);
      return reply.code(204).send();
    },
  );
}
