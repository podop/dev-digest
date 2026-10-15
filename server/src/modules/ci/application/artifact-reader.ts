import {
  MAX_ARTIFACT_JSON_BYTES,
  MAX_ARTIFACT_ZIP_BYTES,
  RESULT_FILE_NAME,
} from '../domain/constants.js';
import { parseResultArtifact, type ArtifactReadResult } from '../domain/ingest.js';
import type { ZipEntryReader } from './ports.js';

/**
 * Read `devdigest-result.json` out of a downloaded artifact ZIP (FR20, NFR5). Both size limits are
 * checked BEFORE anything is inflated or parsed: the zip length first, then the entry's declared
 * size (inside the zip reader). Only the one named entry is read; nothing is written to disk.
 */
export function readResultArtifact(zip: Uint8Array, reader: ZipEntryReader): ArtifactReadResult {
  if (zip.byteLength > MAX_ARTIFACT_ZIP_BYTES) return { ok: false, reason: 'artifact_too_large' };
  const entry = reader.read(zip, RESULT_FILE_NAME, MAX_ARTIFACT_JSON_BYTES);
  if (entry.kind === 'too_large') return { ok: false, reason: 'artifact_too_large' };
  if (entry.kind !== 'entry') return { ok: false, reason: 'artifact_invalid' };
  return parseResultArtifact(entry.bytes);
}
