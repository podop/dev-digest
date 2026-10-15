/**
 * The built agent-runner bundle (`agent-runner/dist/index.js`, specs/export-to-ci.md FR6) read from the
 * repository checkout the API runs from. The root is derived from this file's location
 * (`server/{src,dist}/modules/ci/infrastructure` → five levels up) — no config entry.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { RunnerBundle } from '../application/ports.js';

const BUNDLE_URL = new URL('../../../../../agent-runner/dist/index.js', import.meta.url);

export class FileRunnerBundle implements RunnerBundle {
  constructor(private readonly path: string = fileURLToPath(BUNDLE_URL)) {}

  /** null = the bundle is not built (`ENOENT`); any other read error is a real failure. */
  async read(): Promise<string | null> {
    try {
      return await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}
