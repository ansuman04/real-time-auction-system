import { tracedFetch } from './tracing';
import { isAuction, type AuctionItem } from './catalog';

export function parseBidAmount(value: string): number | null {
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(value)) return null;
  const [dollars, cents = ''] = value.split('.');
  const amount = Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
  return amount > 0 ? amount : null;
}

export async function placeBid(slug: string, bidderId: string, amountMinor: number): Promise<{ accepted: boolean; message: string; auction?: AuctionItem }> {
  const response = await tracedFetch(`/api/auctions/${encodeURIComponent(slug)}/bids`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bidderId, amountMinor }),
  }, 'web.bid', { 'auction.id': slug, 'amount.minor': amountMinor, currency: 'usd', role: 'bidder' });
  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null) throw new Error('Invalid bid response');
  const record = data as Record<string, unknown>;
  if (record.auction !== undefined && !isAuction(record.auction)) throw new Error('Invalid auction in bid response');
  if (response.status === 201 && isAuction(record.auction)) return { accepted: true, message: 'Bid accepted.', auction: record.auction };
  if (response.status >= 400 && response.status < 500 && typeof record.message === 'string') {
    return { accepted: false, message: record.message, auction: record.auction as AuctionItem | undefined };
  }
  throw new Error('Unconfirmed bid outcome');
}
