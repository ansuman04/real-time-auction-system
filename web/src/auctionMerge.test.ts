import { expect, it } from 'vitest';
import { mergeAuction, type AuctionItem } from './catalog';

const initial: AuctionItem = {
  slug: 'merge-fixture', title: 'Fixture', description: 'Fixture', category: 'Other', condition: 'Used',
  seller: 'Alex', sellerId: 'alex-morgan', location: null, currency: 'USD', art: 'gpu', specs: [],
  startingPriceMinor: 10000, currentPriceMinor: 10000, bidCount: 0, bids: [], isClosed: false, finalOutcome: null, endsAt: '2031-01-01T00:00:00Z',
};
const accepted: AuctionItem = { ...initial, currentPriceMinor: 10100, bidCount: 1, bids: [{ id: '1', amountMinor: 10100, bidderId: 'jordan-lee', bidderName: 'Jordan Lee', acceptedAt: '2030-01-01T00:00:00Z' }] };

it('keeps the newer bid when an older closed snapshot arrives and does not reopen on a late success', () => {
  const closed = mergeAuction(accepted, { ...initial, isClosed: true });
  expect(closed).toMatchObject({ isClosed: true, currentPriceMinor: 10100, bidCount: 1 });
  expect(mergeAuction(closed, accepted)).toEqual(closed);
});

it('keeps the durable final outcome when a stale snapshot arrives later', () => {
  const outcome = { closedAt: '2031-01-01T00:00:00Z', winningBid: { bidId: '1', bidderId: 'jordan-lee', bidderName: 'Jordan Lee', amountMinor: 10100 } };
  const closed = { ...accepted, isClosed: true, finalOutcome: outcome };
  expect(mergeAuction(closed, { ...initial, isClosed: true })).toMatchObject({ finalOutcome: outcome, isClosed: true });
});

it('does not carry closed status from a different auction', () => {
  const other = { ...initial, slug: 'another-auction' };
  expect(mergeAuction({ ...accepted, isClosed: true }, other)).toEqual(other);
});
