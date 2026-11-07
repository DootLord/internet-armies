export type User = { id: string; email: string };
type AuthResponse = { user?: User | null; error?: string; message?: string };

export async function authRequest(path: string, body?: { email: string; password: string } | null): Promise<AuthResponse> {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : body === null ? { method: 'POST' } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status === 204) return {};
  const data = await response.json() as AuthResponse;
  if (!response.ok) throw new Error(data.error || 'Authentication request failed.');
  return data;
}
