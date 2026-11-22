import { useState, type FormEvent } from 'react';
import { type AuctionItem, formatCurrency } from './catalog';
import { parseBidAmount, placeBid } from './bidding';

export function BidPanel({ item, userId, enabled, closed, update, refresh }: {
  item: AuctionItem; userId: string; enabled: boolean; closed: boolean; update: (item: AuctionItem) => void; refresh: () => Promise<boolean>;
}) {
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const minimum = item.currentPriceMinor + 100;
  const leading = item.bids[0]?.bidderId === userId;
  const unavailable = !enabled || !userId || userId === item.sellerId || leading || closed || minimum > 999999999;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || recovering || unavailable || uncertain || Date.parse(item.endsAt) <= Date.now()) return;
    const value = parseBidAmount(amount);
    if (value === null) { setMessage('Enter USD 0.01–9,999,999.99 with at most two decimals.'); return; }
    setPending(true); setMessage(''); setUncertain(false);
    try {
      const result = await placeBid(item.slug, userId, value);
      if (result.auction) update(result.auction);
      setMessage(result.message);
      if (result.accepted) setAmount('');
      void refresh();
    } catch {
      setUncertain(true);
      setMessage('Acceptance is unconfirmed. Refresh the auction and inspect bid history before deciding whether to bid again.');
    } finally { setPending(false); }
  }
  async function recover() {
    if (pending || recovering) return;
    setRecovering(true);
    try {
      if (await refresh()) {
        setUncertain(false);
        if (uncertain) setMessage('Auction refreshed. Review bid history before deciding whether to bid again.');
      }
    } finally { setRecovering(false); }
  }
  return <section className="bidding-section" aria-label="Place a bid">
    <p>Closes {new Date(item.endsAt).toLocaleString()} ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p>
    <p>{closed ? 'Ended · This auction is closed.' : userId === item.sellerId ? 'Sellers cannot bid on their own auction.' : !enabled ? 'Bidding is unavailable.' : !userId ? 'Choose a demo user to bid.' : leading ? 'You are the highest bidder. You can bid again after someone outbids you.' : minimum > 999999999 ? 'The maximum bid amount has been reached.' : `Minimum bid ${formatCurrency(minimum)} · At least $1 above the current amount.`}</p>
    <form className="bid-form" onSubmit={submit}>
      <label htmlFor="bid-amount">Your bid (USD)</label>
      <div><span aria-hidden="true">$</span><input id="bid-amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={unavailable || pending} required /><button type="submit" disabled={unavailable || pending || recovering || uncertain}>{pending ? 'Submitting…' : 'Place bid'}</button></div>
    </form>
    {message && <p role="status" aria-live="polite">{message}</p>}
    <button type="button" onClick={() => { void recover(); }} disabled={pending || recovering}>{recovering ? 'Refreshing…' : 'Refresh auction'}</button>
  </section>;
}
