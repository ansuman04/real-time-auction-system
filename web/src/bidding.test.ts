import { afterEach, expect, it, vi } from 'vitest';
import { parseBidAmount, placeBid } from './bidding';
afterEach(() => vi.unstubAllGlobals());

it('parses exact USD cents and rejects precision/range errors', () => {
  expect(parseBidAmount('101.01')).toBe(10101);
  expect(parseBidAmount('0.01')).toBe(1);
  expect(parseBidAmount('9999999.99')).toBe(999999999);
  for (const value of ['0', '-1', '1.001', '1e3', '10000000', '', 'NaN']) expect(parseBidAmount(value)).toBeNull();
});

it('surfaces a stale rejection without automatically resubmitting', async () => {
  const fetch = vi.fn().mockResolvedValue({ status: 409, json: async () => ({ message: 'Below updated minimum' }) });
  vi.stubGlobal('fetch', fetch);
  expect(await placeBid('an auction', 'jordan-lee', 10100)).toEqual({ accepted: false, message: 'Below updated minimum', auction: undefined });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe('/api/auctions/an%20auction/bids');
});

it('does not retry an uncertain network outcome or accept malformed success data', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('Connection lost'));
  vi.stubGlobal('fetch', fetch);
  await expect(placeBid('auction', 'jordan-lee', 10100)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValue({ status: 201, json: async () => ({ auction: { currentPriceMinor: 'bad' } }) });
  await expect(placeBid('auction', 'jordan-lee', 10100)).rejects.toThrow('Invalid auction');
});
