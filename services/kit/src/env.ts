// Configuration comes only from environment variables (12-factor): the same
// image runs locally, on Coolify and on Kubernetes, with different env. A
// missing required variable stops the service at boot, not at first use.
export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const envInt = (name: string, fallback?: number) => {
  const v = Number(env(name, fallback?.toString()));
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
};
