/** Directory names the walker never enters and no document path may contain. */
export const EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  'out',
  'vendor',
];

/** Doc type when no `specs` / `docs` / `insights` directory is in the path. */
export const DEFAULT_DOC_TYPE = 'docs' as const;

/** Required file extension of a document path. */
export const DOC_EXTENSION = '.md';
