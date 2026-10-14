// Adapted from avito-shopping-mcp, MIT; see the adjacent license.
export class AvitoMcpError extends Error {
  constructor(code, message, options) { super(message, options); this.code = code; this.name = 'AvitoMcpError'; }
}
export function safeError(error) {
  return error instanceof AvitoMcpError ? {code:error.code, message:error.message} : {code:'UNKNOWN',message:'Unexpected internal error.'};
}
