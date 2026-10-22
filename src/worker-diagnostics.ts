export function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

function safeText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, safeUrl)
    .replace(
      /(["']?(?:access_token|refresh_token|api[_-]?key|password|authorization)["']?\s*[=:]\s*)["'][^"']*["']/gi,
      '$1"[redacted]"',
    )
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(
      /\b((?:access_token|refresh_token|api[_-]?key|password|authorization)\s*[=:]\s*)[^\s,;]+/gi,
      '$1[redacted]',
    )
    .slice(0, 8000);
}

export interface DiagnosticError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: DiagnosticError;
}

export function diagnosticError(error: unknown, depth = 0): DiagnosticError {
  if (!(error instanceof Error))
    return { name: 'NonError', message: '[non-Error thrown]' };
  const code: unknown = Reflect.get(error, 'code');
  return {
    name: safeText(error.name),
    message: safeText(error.message),
    stack: error.stack ? safeText(error.stack) : undefined,
    ...(typeof code === 'string' ? { code: safeText(code) } : {}),
    ...(error.cause !== undefined && depth < 2
      ? { cause: diagnosticError(error.cause, depth + 1) }
      : {}),
  };
}

export function deliveryEvent(fields: object): void {
  try {
    console.log(JSON.stringify(fields));
  } catch {
    // Diagnostics must not turn a saved checkpoint into a failed delivery.
  }
}
