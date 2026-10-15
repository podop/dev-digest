import { unzipSync } from 'fflate';
import type { ZipEntryReader, ZipEntryResult } from '../application/ports.js';

/**
 * `ZipEntryReader` over fflate. The entry's declared size (central directory) is checked in the
 * unzip `filter`, BEFORE it is inflated; only the one named entry is ever inflated and nothing is
 * written to disk.
 */
export class FflateZipEntryReader implements ZipEntryReader {
  read(zip: Uint8Array, entryName: string, maxEntryBytes: number): ZipEntryResult {
    let tooLarge = false;
    let entry: Uint8Array | undefined;
    try {
      const files = unzipSync(zip, {
        filter: (file) => {
          if (file.name !== entryName) return false;
          if (file.originalSize > maxEntryBytes) {
            tooLarge = true;
            return false;
          }
          return true;
        },
      });
      entry = files[entryName];
    } catch {
      return { kind: 'invalid' };
    }
    if (tooLarge || (entry && entry.byteLength > maxEntryBytes)) return { kind: 'too_large' };
    if (!entry) return { kind: 'missing' };
    return { kind: 'entry', bytes: entry };
  }
}
