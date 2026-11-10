// Structured JSON logs on stdout: Docker, Coolify and later Kubernetes collect
// stdout, and JSON lines can be searched and filtered (Loki, Elastic...) without
// regex. Pretty-printing is a dev-only pipe: `npm run dev | npx pino-pretty`.
import { pino } from 'pino';

export const logger = (service: string) =>
  pino({ name: service, level: process.env.LOG_LEVEL ?? 'info', base: { service } });

export type Logger = ReturnType<typeof logger>;
