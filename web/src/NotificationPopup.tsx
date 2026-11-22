import { received } from './tracing';
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { formatCurrency } from './catalog';

interface PopupNotification {
  notificationId: string;
  traceContext?: unknown;
  recipientId: string;
  recipientRole: 'seller' | 'winner';
  payload: {
    auctionSlug: string;
    auctionTitle: string;
    sellerName: string;
    recipientRole: 'seller' | 'winner';
    winner: null | { bidderId: string; bidderName: string; amountMinor: number };
  };
  createdAt: string;
}

export function NotificationPopup({ userId }: { userId: string }) {
  const [pending, setPending] = useState<PopupNotification[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<ReturnType<typeof io> | null>(null);

  useEffect(() => {
    setPending([]);
    setConnected(false);
    const socket = io({ autoConnect: false, reconnection: true, timeout: 3000 });
    socketRef.current = socket;
    const add = (item: PopupNotification) => setPending((current) => current.some((entry) => entry.notificationId === item.notificationId)
      ? current : [...current, item].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.notificationId.localeCompare(right.notificationId)));
    socket.on('connect', () => {
      socket.emit('notification:watch', { userId }, (result: { ok: boolean; notifications?: PopupNotification[] }) => {
        if (!result?.ok) return;
        setConnected(true);
        for (const item of result.notifications ?? []) add(item);
      });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('notification:received', (item: PopupNotification) => { received('web.notification.received', item.traceContext, { 'notification.id': item.notificationId, 'auction.id': item.payload.auctionSlug, role: item.recipientRole, outcome: 'received' }); add(item); });
    socket.connect();
    return () => { socketRef.current = null; socket.removeAllListeners(); socket.close(); };
  }, [userId]);

  const current = pending[0];
  if (!current) return null;
  const dismiss = () => {
    socketRef.current?.emit('notification:dismiss', { notificationId: current.notificationId }, (result: { ok: boolean }) => {
      if (result?.ok) setPending((items) => items.filter((item) => item.notificationId !== current.notificationId));
    });
  };
  const winner = current.payload.winner;
  const message = current.recipientRole === 'winner'
    ? <>You won <strong>{current.payload.auctionTitle}</strong> with a bid of <strong>{winner ? formatCurrency(winner.amountMinor) : ''}</strong>.</>
    : winner
      ? <><strong>{winner.bidderName}</strong> won <strong>{current.payload.auctionTitle}</strong> at <strong>{formatCurrency(winner.amountMinor)}</strong>.</>
      : <><strong>{current.payload.auctionTitle}</strong> closed without any bids. There is no winner.</>;

  return <div className="notification-backdrop" data-testid="notification-backdrop">
    <section className="notification-modal" role="dialog" aria-modal="true" aria-labelledby="notification-title" data-testid="notification-modal">
      <p className="eyebrow">Auction update</p>
      <h2 id="notification-title">{current.recipientRole === 'winner' ? 'Congratulations' : 'Auction closed'}</h2>
      <p>{message}</p>
      <a href={'/items/' + encodeURIComponent(current.payload.auctionSlug)}>View auction</a>
      <button type="button" onClick={dismiss} disabled={!connected}>Dismiss</button>
    </section>
  </div>;
}
