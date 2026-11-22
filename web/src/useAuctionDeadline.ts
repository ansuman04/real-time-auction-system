import { useEffect, useRef, useState } from 'react';

// Deadline presentation must not depend on the next successful polling request.
// Re-arm on activation because background timers can be delayed or suspended.
export function observeDeadline(endsAt: string, update: (ended: boolean) => void, refresh: () => void) {
  const deadline = Date.parse(endsAt);
  let timer: number | undefined;
  function check() {
    window.clearTimeout(timer);
    const remaining = deadline - Date.now();
    update(remaining <= 0);
    if (remaining > 0) timer = window.setTimeout(check, Math.min(remaining, 2147483647));
  }
  function activate() {
    if (document.visibilityState === 'hidden') return;
    check();
    refresh();
  }
  check();
  window.addEventListener('focus', activate);
  document.addEventListener('visibilitychange', activate);
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener('focus', activate);
    document.removeEventListener('visibilitychange', activate);
  };
}

export function useAuctionDeadline(endsAt: string | undefined, refresh?: () => void) {
  const [ended, setEnded] = useState(() => !!endsAt && Date.parse(endsAt) <= Date.now());
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!endsAt) { setEnded(false); return; }
    return observeDeadline(endsAt, setEnded, () => refreshRef.current?.());
  }, [endsAt]);
  return ended;
}
