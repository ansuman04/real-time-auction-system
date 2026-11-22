import { useEffect, useRef, useState } from 'react';
import { activeUserKey, loadMarketplace, selectActiveUser, type Capabilities, type DemoUser } from './marketplace';

export function useMarketplace() {
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [activeUserId, setActiveUserId] = useState('');
  const activeUserRef = useRef('');
  const [capabilities, setCapabilities] = useState<Capabilities>({ postAuctions: false, placeBids: false });
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    loadMarketplace(controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      let saved: string | null = null;
      try { saved = sessionStorage.getItem(activeUserKey); } catch { /* Storage is optional. */ }
      const selected = selectActiveUser(data.users, saved ?? activeUserRef.current);
      setUsers(data.users);
      setActiveUserId(selected);
      activeUserRef.current = selected;
      setCapabilities(data.capabilities);
      try { sessionStorage.setItem(activeUserKey, selected); } catch { /* Keep the session usable. */ }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to load demo users.');
    });
    return () => controller.abort();
  }, [attempt]);
  const switchUser = (id: string) => {
    const selected = selectActiveUser(users, id);
    setActiveUserId(selected);
    activeUserRef.current = selected;
    try { sessionStorage.setItem(activeUserKey, selected); } catch { /* In-memory switching still works. */ }
  };
  return { users, activeUserId, capabilities, error, switchUser, retry: () => setAttempt((value) => value + 1) };
}
