// Health probes and graceful shutdown: what an orchestrator (Coolify now,
// Kubernetes later) needs to run a service safely.
//
//   /healthz  liveness:  the process is alive. Failing it gets the container restarted.
//   /readyz   readiness: it can do useful work right now (database and bus connected).
//             Failing it takes the instance out of rotation but doesn't kill it.
//
// On SIGTERM (a deploy, a scale-down, a node drain) the service stops taking new
// work, finishes what it has, and exits before the orchestrator's grace period
// (30s by default) runs out and it gets SIGKILLed.
import http from 'node:http';
import type { Logger } from './log';

export type Check = () => boolean | Promise<boolean>;

/** Answer the probes on their own port (for services that have no HTTP server of their own). */
export function probeServer(port: number, ready: Check) {
  const server = http.createServer((req, res) => void handleProbe(req, res, ready));
  server.listen(port);
  return server;
}

/** Answer /healthz and /readyz. Returns false for any other path, so it can sit in front of an app. */
export async function handleProbe(req: http.IncomingMessage, res: http.ServerResponse, ready: Check): Promise<boolean> {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
    return true;
  }
  if (req.url === '/readyz') {
    const ok = await Promise.resolve(ready()).catch(() => false);
    res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' }).end(ok ? 'ready\n' : 'not ready\n');
    return true;
  }
  if (!res.headersSent) res.writeHead(404).end();
  return false;
}

/**
 * Run `steps` in order on SIGTERM/SIGINT, then exit. A second signal, or a step
 * hanging past the deadline, forces the exit.
 */
export function onShutdown(log: Logger, steps: (() => Promise<unknown> | unknown)[], deadlineMs = 20_000) {
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info({ signal }, 'shutting down');
    setTimeout(() => {
      log.error('shutdown deadline passed, forcing exit');
      process.exit(1);
    }, deadlineMs).unref();
    for (const step of steps) {
      try {
        await step();
      } catch (e) {
        log.error({ err: e }, 'shutdown step failed');
      }
    }
    log.info('bye');
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}
