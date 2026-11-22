import { useCallback, useEffect, useRef, useState } from 'react';
import { loadAuction, loadAuctions, mergeAuction, type AuctionItem } from './catalog';
import { io } from 'socket.io-client';

export function useAuctionData(key: string, detail: boolean) {
  const [data, setData] = useState<AuctionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [liveStatus, setLiveStatus] = useState('Connecting live updates…');
  const refreshRef = useRef<() => Promise<boolean>>(async () => false);
  useEffect(() => {
    let disposed = false;
    let loaded = false;
    let active: AbortController | undefined;
    let timer: number | undefined;
    let running: Promise<boolean> | undefined;
    let dirty = false;
    let joined = false;
    let subscription = 0;
    let suspended = false;
    let joinTimer: number | undefined;
    const socket = detail ? io({ autoConnect: false, forceNew: true, reconnectionDelayMax: 3000 }) : undefined;
    const schedule = () => {
      // Tests may disable only fallback polling to prove the actual live path.
      if (detail && import.meta.env.VITE_DETAIL_POLLING === 'off') return;
      timer = window.setTimeout(() => { void automatic(); }, detail ? 5000 : 60000);
    };
    async function read(): Promise<boolean> {
      if (disposed) return false;
      window.clearTimeout(timer);
      const controller = new AbortController();
      const readSubscription = joined ? subscription : -1;
      active = controller;
      if (!loaded) setLoading(true);
      setError('');
      try {
        const items = detail
          ? await loadAuction(key, controller.signal).then((item) => item ? [item] : [])
          : await loadAuctions(key, controller.signal);
        if (disposed || controller.signal.aborted) return false;
        setData((previous) => items.map((item) => mergeAuction(previous.find((old) => old.slug === item.slug), item)));
        loaded = true;
        if (joined && socket?.connected && readSubscription === subscription) setLiveStatus('Live updates connected');
        return true;
      } catch (reason: unknown) {
        if (!disposed && !controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Unable to load auctions.');
          if (detail) setLiveStatus('Updates may be delayed · refresh failed');
        }
        return false;
      } finally {
        if (!disposed && active === controller) {
          setLoading(false);
          active = undefined;
        }
      }
    }
    function launch(): Promise<boolean> {
      const request = read();
      running = request;
      void request.finally(() => {
        if (disposed || running !== request) return;
        running = undefined;
        if (dirty) { dirty = false; void launch(); }
        else schedule();
      });
      return request;
    }
    function automatic(): Promise<boolean> {
      if (disposed) return Promise.resolve(false);
      if (running) { dirty = true; return running; }
      return launch();
    }
    refreshRef.current = () => {
      active?.abort();
      dirty = false;
      return launch();
    };
    function retryJoin() {
      window.clearTimeout(joinTimer);
      joinTimer = window.setTimeout(() => {
        if (disposed || suspended || !navigator.onLine) return;
        if (socket?.connected) watch(); else socket?.connect();
      }, 2000);
    }
    function watch() {
      window.clearTimeout(joinTimer);
      const watching = ++subscription;
      joined = false;
      setLiveStatus('Catching up live updates…');
      socket?.timeout(3000).emit('auction:watch', { auctionSlug: key }, (failure: Error | null, reply: unknown) => {
        if (disposed || !socket.connected || watching !== subscription) return;
        if (failure || !reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true) {
          setLiveStatus('Updates may be delayed · reconnecting');
          retryJoin();
          return;
        }
        joined = true;
        void automatic();
      });
    }
    socket?.on('connect', watch);
    socket?.on('auction:changed', (payload: unknown) => {
      if (joined && payload && typeof payload === 'object' && 'auctionSlug' in payload && payload.auctionSlug === key) void automatic();
    });
    const disconnected = () => {
      subscription++;
      joined = false;
      if (!disposed) { setLiveStatus('Updates may be delayed · reconnecting'); retryJoin(); }
    };
    socket?.on('disconnect', disconnected);
    socket?.on('connect_error', disconnected);
    const offline = () => {
      joined = false;
      window.clearTimeout(joinTimer);
      socket?.disconnect();
      if (!disposed) setLiveStatus('Updates may be delayed · reconnecting');
    };
    const online = () => { suspended = false; if (!disposed && navigator.onLine) socket?.connect(); };
    const hidden = () => { suspended = true; socket?.disconnect(); window.clearTimeout(joinTimer); };
    if (socket) {
      window.addEventListener('offline', offline);
      window.addEventListener('online', online);
      window.addEventListener('pagehide', hidden);
      window.addEventListener('pageshow', online);
    }
    void launch();
    socket?.connect();
    return () => {
      disposed = true;
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      window.removeEventListener('pagehide', hidden);
      window.removeEventListener('pageshow', online);
      socket?.removeAllListeners();
      socket?.disconnect();
      active?.abort();
      window.clearTimeout(timer);
      window.clearTimeout(joinTimer);
      refreshRef.current = async () => false;
    };
  }, [key, detail]);
  const retry = useCallback(() => refreshRef.current(), []);
  const update = useCallback((item: AuctionItem) => setData((previous) => [mergeAuction(previous.find((old) => old.slug === item.slug), item)]), []);
  return { data, loading, error, retry, update, liveStatus };
}
