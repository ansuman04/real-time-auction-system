import { afterEach, expect, it, vi } from 'vitest';
import { loadMarketplace, selectActiveUser } from './marketplace';

afterEach(() => vi.unstubAllGlobals());
const users = [{ id: 'one', displayName: 'One' }, { id: 'two', displayName: 'Two' }];
it('keeps an existing tab selection without drawing another random user', () => {
  const random = vi.fn(() => 0);
  expect(selectActiveUser(users, 'two', random)).toBe('two');
  expect(random).not.toHaveBeenCalled();
});
it('randomly assigns a valid user for new tabs and stale stored IDs', () => {
  expect(selectActiveUser(users, null, () => 0)).toBe('one');
  expect(selectActiveUser(users, null, () => 0.999)).toBe('two');
  expect(selectActiveUser(users, 'deleted-user', () => 0.999)).toBe('two');
  expect(selectActiveUser([], null)).toBe('');
});
it('validates users and API-owned capabilities', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('users') ? users : { postAuctions: false, placeBids: false } })));
  await expect(loadMarketplace(new AbortController().signal)).resolves.toEqual({ users, capabilities: { postAuctions: false, placeBids: false } });
});
it.each([{ invalid: [] }, { invalid: [{ id: '', displayName: 'Empty ID' }] }, { invalid: [users[0], users[0]] }, { invalid: [{ id: 'bad', displayName: 12 }] }])('rejects malformed users $invalid', async ({ invalid }) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('users') ? invalid : { postAuctions: false, placeBids: false } })));
  await expect(loadMarketplace(new AbortController().signal)).rejects.toThrow('invalid marketplace data');
});
it('reports failure instead of inventing local users', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  await expect(loadMarketplace(new AbortController().signal)).rejects.toThrow('Unable to load demo users');
});
