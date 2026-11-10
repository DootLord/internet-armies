import { afterEach, describe, expect, it, vi } from 'vitest';
import { authRequest } from '../../ui/authApi';

afterEach(() => vi.unstubAllGlobals());

describe('account API', () => {
  it('sends logout as an empty POST and accepts a 204 response', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    await expect(authRequest('logout', null)).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledWith('/api/logout', { method: 'POST' });
  });

  it('sends login as JSON and surfaces server errors', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Invalid email or password.' }), { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    await expect(authRequest('login', { email: 'a@example.test', password: 'wrong' })).rejects.toThrow('Invalid email or password.');
    expect(fetch).toHaveBeenCalledWith('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.test', password: 'wrong' }),
    });
  });
});
