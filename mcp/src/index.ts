#!/usr/bin/env -S npx tsx
/**
 * devdigest-mcp — stdio entrypoint. stdout carries the MCP protocol, so every
 * diagnostic goes to stderr. Needs the DevDigest API running (./scripts/dev.sh);
 * it starts without it and each tool call explains how to fix that.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHttpApi } from './api.js';
import { loadConfig, RUN_WAIT_MS } from './config.js';
import { createServer } from './server.js';
import { abortableSleep } from './tools/shared.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer({
    api: createHttpApi({ baseUrl: config.apiUrl, requestTimeoutMs: config.requestTimeoutMs }),
    pollIntervalMs: config.pollIntervalMs,
    runWaitMs: RUN_WAIT_MS,
    now: Date.now,
    sleep: abortableSleep,
  });
  await server.connect(new StdioServerTransport());
  console.error(`devdigest-mcp: ready on stdio, API ${config.apiUrl}`);
}

main().catch((err) => {
  console.error('devdigest-mcp: failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
