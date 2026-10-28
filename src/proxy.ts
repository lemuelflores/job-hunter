import { type NextRequest, NextResponse } from 'next/server.js';
import { validLocalHost, webPort } from './app/local-access.ts';

export function proxy(request: NextRequest): NextResponse {
  if (!validLocalHost(request.headers.get('host'), webPort()))
    return NextResponse.json({ error: 'Host is not allowed' }, { status: 403 });
  return NextResponse.next();
}
