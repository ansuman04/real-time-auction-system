export type DemoUser = { id: string; displayName: string };
export type Capabilities = { postAuctions: boolean; placeBids: boolean };
export const activeUserKey = 'auction-part-8-active-user';

export function selectActiveUser(users: DemoUser[], saved: string | null, random: () => number = Math.random): string {
  const existing = users.find((user) => user.id === saved);
  if (existing) return existing.id;
  return users.length ? users[Math.floor(random() * users.length)].id : '';
}

export async function loadMarketplace(signal: AbortSignal): Promise<{ users: DemoUser[]; capabilities: Capabilities }> {
  const [usersResponse, capabilitiesResponse] = await Promise.all([
    fetch('/api/users', { signal }), fetch('/api/capabilities', { signal }),
  ]);
  if (!usersResponse.ok || !capabilitiesResponse.ok) throw new Error('Unable to load demo users. Please retry.');
  const users: unknown = await usersResponse.json();
  const capabilities: unknown = await capabilitiesResponse.json();
  if (!Array.isArray(users) || users.length === 0 || !users.every((user: unknown) =>
    typeof user === 'object' && user !== null && 'id' in user && typeof user.id === 'string' && user.id.length > 0
    && 'displayName' in user && typeof user.displayName === 'string' && user.displayName.length > 0)
    || new Set(users.map((user: DemoUser) => user.id)).size !== users.length
    || typeof capabilities !== 'object' || capabilities === null
    || !('postAuctions' in capabilities) || typeof capabilities.postAuctions !== 'boolean'
    || !('placeBids' in capabilities) || typeof capabilities.placeBids !== 'boolean') {
    throw new Error('The server returned invalid marketplace data.');
  }
  return { users: users as DemoUser[], capabilities: { postAuctions: capabilities.postAuctions, placeBids: capabilities.placeBids } };
}
