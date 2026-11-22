import { z } from 'zod';

export const categories = ['GPUs', 'CPUs', 'Memory', 'Chassis', 'Networking', 'Cooling', 'Other'] as const;
export const createAuctionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(5000),
  category: z.enum(categories),
  condition: z.string().trim().min(1).max(100),
  sellerId: z.string().trim().min(1).max(80),
  location: z.string().trim().min(1).max(200),
  startingPrice: z.string().regex(/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/, 'Enter USD 0.01–9,999,999.99 with at most two decimals')
    .transform((value) => {
      const [dollars, cents = ''] = value.split('.');
      return Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
    }).refine((value) => value > 0, 'Starting price must be greater than zero'),
  endsAt: z.string().datetime({ offset: true }).refine((value) => Date.parse(value) > Date.now(), 'Closing time must be in the future'),
}).strict();

export const artByCategory: Record<typeof categories[number], string> = {
  GPUs: 'gpu', CPUs: 'cpu', Memory: 'memory', Chassis: 'chassis', Networking: 'switch', Cooling: 'cooling', Other: 'chassis',
};

export interface AuctionRow {
  bids?: { id: string; bidderId: string; bidderName: string; amountMinor: number; acceptedAt: string }[];
  close_auction_slug?: string | null;
  close_closed_at?: Date | null;
  close_winning_bid_id?: string | null;
  close_winner_id?: string | null;
  close_winner_name?: string | null;
  close_winning_amount_minor?: number | null;
  slug: string;
  title: string;
  description: string;
  category: string;
  condition: string;
  seller: string;
  seller_id: string;
  location: string | null;
  starting_price_minor: number;
  ends_at: Date;
  art: string;
  specs: [string, string][];
}

export function auctionResponse(row: AuctionRow, asOf: Date) {
  const bids = row.bids ?? [];
  const finalOutcome = row.close_auction_slug ? {
    closedAt: row.close_closed_at!.toISOString(),
    winningBid: row.close_winning_bid_id ? {
      bidId: row.close_winning_bid_id,
      bidderId: row.close_winner_id!,
      bidderName: row.close_winner_name!,
      amountMinor: row.close_winning_amount_minor!,
    } : null,
  } : null;
  return {
    isClosed: finalOutcome !== null || asOf >= row.ends_at,
    finalOutcome,
    bids, bidCount: bids.length, currentPriceMinor: bids[0]?.amountMinor ?? row.starting_price_minor,
    slug: row.slug, title: row.title, description: row.description, category: row.category,
    condition: row.condition, seller: row.seller, startingPriceMinor: row.starting_price_minor,
    sellerId: row.seller_id, location: row.location,
    currency: 'USD', endsAt: row.ends_at.toISOString(), art: row.art, specs: row.specs,
  };
}
