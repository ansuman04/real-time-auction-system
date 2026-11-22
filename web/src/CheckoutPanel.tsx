import { tracedFetch, received } from './tracing';
import { io } from 'socket.io-client';
import { useEffect, useRef, useState } from 'react';
import { formatCurrency } from './catalog';

export function CheckoutPanel({ slug, userId, amountMinor, role = 'winner' }: { slug: string; userId: string; amountMinor: number; role?: 'seller' | 'winner' }) {
  const [status, setStatus] = useState<'loading' | 'unpaid' | 'pending' | 'paid'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const starting = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    let stopped = false;
    let confirmed = false;
    const controller = new AbortController();
    setStatus('loading'); setError(''); setBusy(false); starting.current = false;
    const refresh = async () => {
      if (stopped || confirmed) return;
      try {
        const response = await fetch(`/api/auctions/${encodeURIComponent(slug)}/checkout?userId=${encodeURIComponent(userId)}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Could not load payment status.');
        const body = await response.json();
        if (!['unpaid', 'pending', 'paid'].includes(body.status)) throw new Error('Invalid payment status.');
        if (!stopped) { confirmed = confirmed || body.status === 'paid'; setStatus((previous) => previous === 'paid' ? previous : body.status); setError(''); }
      } catch (err) { if (!stopped) setError(err instanceof Error ? err.message : 'Could not load payment status.'); }
    };
    void refresh();
    const socket = io({ autoConnect: false, reconnection: true });
    socket.on('connect', () => socket.emit('payment:watch', { auctionSlug: slug, userId }, (result: { ok: boolean }) => { if (result?.ok) void refresh(); }));
    socket.on('payment:changed', (event: { auctionSlug?: string; traceContext?: unknown }) => { if (event?.auctionSlug === slug) { received('web.payment.received', event.traceContext, { 'auction.id': slug, role, outcome: 'refresh_requested' }); void refresh(); } });
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    socket.connect();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { socket.removeAllListeners(); socket.close(); window.removeEventListener('focus', onFocus); window.removeEventListener('online', onFocus); stopped = true; controller.abort(); clearInterval(timer); if (generation.current === current) generation.current++; };
  }, [slug, userId]);
  const start = async () => {
    if (starting.current || role !== 'winner') return;
    const current = generation.current;
    starting.current = true; setBusy(true); setError('');
    try {
      const response = await tracedFetch(`/api/auctions/${encodeURIComponent(slug)}/checkout`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ buyerId: userId }),
      }, 'web.checkout', { 'auction.id': slug, role: 'winner', 'amount.minor': amountMinor, currency: 'usd' });
      const body = await response.json();
      if (generation.current !== current) return;
      if (!response.ok) throw new Error(body.message ?? 'Could not start checkout.');
      if (body.status === 'paid') setStatus('paid');
      else if (body.confirmationPending === true) setStatus('pending');
      else if (typeof body.url === 'string') window.location.assign(body.url);
      else throw new Error('Could not open checkout.');
    } catch (err) { if (generation.current === current) setError(err instanceof Error ? err.message : 'Could not start checkout.'); }
    finally { if (generation.current === current) { starting.current = false; setBusy(false); } }
  };
  return <section className="final-outcome" aria-label={role === 'seller' ? 'Seller payment status' : 'Winner checkout'} data-testid="checkout-panel">
    <h2>{status === 'paid' ? 'Payment confirmed' : role === 'seller' ? 'Awaiting payment' : 'Winner checkout'}</h2>
    <p role="status">{status === 'paid' ? `Paid ${formatCurrency(amountMinor)}.${role === 'winner' ? ' Thank you.' : ''}` : status === 'loading' ? 'Checking payment status…' : status === 'pending' ? 'Checkout started. If you have paid, confirmation will appear here automatically. Otherwise, resume checkout.' : role === 'seller' ? 'The winner has not paid yet.' : `Your winning total is ${formatCurrency(amountMinor)}.`}</p>
    {role === 'winner' && new URLSearchParams(window.location.search).get('checkout') === 'canceled' && status !== 'paid' && <p>Checkout canceled. You can resume when ready.</p>}
    {error && <p role="alert">{error}</p>}
    {role === 'winner' && status !== 'paid' && <button className="checkout-button" type="button" disabled={busy || status === 'loading'} onClick={() => void start()}>{busy ? 'Starting checkout…' : status === 'pending' ? 'Resume checkout' : 'Pay now'}</button>}
  </section>;
}
