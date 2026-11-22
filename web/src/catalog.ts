export type ProductArtKind = 'gpu' | 'cpu' | 'memory' | 'chassis' | 'switch' | 'cooling';
export type Bid = { id: string; bidderId: string; bidderName: string; amountMinor: number; acceptedAt: string };
export type AuctionFinalOutcome = {
  closedAt: string;
  winningBid: null | { bidId: string; bidderId: string; bidderName: string; amountMinor: number };
};
export type AuctionItem = {
  isClosed: boolean;
  finalOutcome: AuctionFinalOutcome | null;
  currentPriceMinor: number; bidCount: number; bids: Bid[];
  slug: string; title: string; description: string; category: string; condition: string;
  seller: string; startingPriceMinor: number; endsAt: string; art: ProductArtKind;
  sellerId: string; location: string | null;
  currency: 'USD'; specs: Array<[string, string]>;
};

export function formatCurrency(minor: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(minor / 100);
}

export function closingLabel(endsAt: string): string {
  const remaining = Date.parse(endsAt) - Date.now();
  if (remaining <= 0) return 'Ended';
  const minutes = Math.ceil(remaining / 60000);
  if (minutes < 60) return `${minutes}m left`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h left`;
}

export function isAuction(value: unknown): value is AuctionItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return ['slug', 'title', 'description', 'category', 'condition', 'seller', 'sellerId'].every((key) => typeof item[key] === 'string')
    && typeof item.startingPriceMinor === 'number' && Number.isSafeInteger(item.startingPriceMinor) && item.startingPriceMinor > 0
    && typeof item.currentPriceMinor === 'number' && Number.isSafeInteger(item.currentPriceMinor) && item.currentPriceMinor >= item.startingPriceMinor
    && Array.isArray(item.bids) && item.bids.every(isBid) && item.bidCount === item.bids.length
    && (item.bids.length === 0 ? item.currentPriceMinor === item.startingPriceMinor : item.currentPriceMinor === item.bids[0].amountMinor)
    && typeof item.isClosed === 'boolean'
    && (item.finalOutcome === null || isFinalOutcome(item.finalOutcome))
    && item.currency === 'USD' && (item.location === null || typeof item.location === 'string')
    && typeof item.endsAt === 'string' && Number.isFinite(Date.parse(item.endsAt))
    && ['gpu','cpu','memory','chassis','switch','cooling'].includes(String(item.art))
    && Array.isArray(item.specs) && item.specs.every((spec: unknown) => Array.isArray(spec) && spec.length === 2 && spec.every((part: unknown) => typeof part === 'string'));
}

// Bids are append-only and auctions cannot reopen. A late response must not
// replace a newer price or undo an authoritative closed verdict.
export function mergeAuction(current: AuctionItem | undefined, incoming: AuctionItem): AuctionItem {
  if (!current || current.slug !== incoming.slug) return incoming;
  const latest = current.bidCount > incoming.bidCount ? current : incoming;
  return {
    ...latest,
    isClosed: current.isClosed || incoming.isClosed,
    finalOutcome: current.finalOutcome ?? incoming.finalOutcome,
  };
}

function isBid(value: unknown): value is Bid {
  if (typeof value !== 'object' || value === null) return false;
  const bid = value as Record<string, unknown>;
  return typeof bid.id === 'string' && /^\d+$/.test(bid.id)
    && typeof bid.bidderId === 'string' && typeof bid.bidderName === 'string'
    && typeof bid.amountMinor === 'number' && Number.isSafeInteger(bid.amountMinor) && bid.amountMinor > 0 && bid.amountMinor <= 999999999
    && typeof bid.acceptedAt === 'string' && Number.isFinite(Date.parse(bid.acceptedAt));
}

function isFinalOutcome(value: unknown): value is AuctionFinalOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const outcome = value as Record<string, unknown>;
  if (typeof outcome.closedAt !== 'string' || !Number.isFinite(Date.parse(outcome.closedAt))) return false;
  if (outcome.winningBid === null) return true;
  if (typeof outcome.winningBid !== 'object' || outcome.winningBid === null) return false;
  const bid = outcome.winningBid as Record<string, unknown>;
  return typeof bid.bidId === 'string' && /^\d+$/.test(bid.bidId)
    && typeof bid.bidderId === 'string' && typeof bid.bidderName === 'string'
    && typeof bid.amountMinor === 'number' && Number.isSafeInteger(bid.amountMinor)
    && bid.amountMinor >= 1 && bid.amountMinor <= 999999999;
}

export async function loadAuctions(query: string, signal: AbortSignal): Promise<AuctionItem[]> {
  const response = await fetch(`/api/auctions?q=${encodeURIComponent(query)}`, { signal });
  if (!response.ok) throw new Error('Unable to load auctions. Please retry.');
  const data: unknown = await response.json();
  if (!Array.isArray(data) || !data.every(isAuction)) throw new Error('The server returned invalid auction data.');
  return data;
}

export async function loadAuction(slug: string, signal: AbortSignal): Promise<AuctionItem | null> {
  const response = await fetch(`/api/auctions/${encodeURIComponent(slug)}`, { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Unable to load this auction. Please retry.');
  const data: unknown = await response.json();
  if (!isAuction(data)) throw new Error('The server returned invalid auction data.');
  return data;
}
