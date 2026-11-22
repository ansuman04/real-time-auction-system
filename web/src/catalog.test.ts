import { describe, expect, it, vi, afterEach } from 'vitest';
import { formatCurrency, closingLabel, loadAuctions } from './catalog';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('auction presentation', () => {
  it('formats integer cents as USD without losing decimals', () => {
    expect(formatCurrency(123456)).toBe('$1,234.56');
    expect(formatCurrency(1)).toBe('$0.01');
  });
  it('shows actual deadline status', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    expect(closingLabel('2030-01-01T00:00:00Z')).toBe('Ended');
    expect(closingLabel('2030-01-01T00:30:00Z')).toBe('30m left');
  });
  it('rejects invalid API data rather than displaying it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [{ startingPriceMinor: 'bad' }] }));
    await expect(loadAuctions('', new AbortController().signal)).rejects.toThrow('invalid auction data');
  });
});
