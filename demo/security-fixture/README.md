# Security review fixture (intentionally vulnerable)

`src/accounts-api.ts` is **deliberately insecure** demo code, a target for DevDigest's
**Security Reviewer** agent (via the UI or the `devdigest` MCP server). Nothing imports,
builds or deploys it, and it is not part of any package.

Do not copy any of it into real code.
