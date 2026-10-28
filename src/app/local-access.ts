export function webPort(): number {
  const value = Number(process.env.JOB_HUNTER_WEB_PORT ?? '3000');
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error('Invalid JOB_HUNTER_WEB_PORT');
  return value;
}

export function validLocalHost(host: string | null, port: number): boolean {
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}
