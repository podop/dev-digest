import { parse, stringify } from 'yaml';
import type { YamlCodec } from '../application/ports.js';

/** `YamlCodec` over the `yaml` package. `parse` throws on malformed YAML; `stringify` keeps long lines intact. */
export class YamlLibCodec implements YamlCodec {
  parse(text: string): unknown {
    return parse(text);
  }

  stringify(value: unknown): string {
    return stringify(value, { lineWidth: 0 });
  }
}
