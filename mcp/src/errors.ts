/**
 * A failure the MCP client should see as a tool error (isError: true), not a
 * protocol error: a stable `code`, what went wrong, and the concrete next step
 * the calling model (or its user) can take.
 */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextStep: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export function toolErrorText(err: ToolError): string {
  return `[${err.code}] ${err.message}\nNext step: ${err.nextStep}`;
}
