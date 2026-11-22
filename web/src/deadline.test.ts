import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { observeDeadline } from './useAuctionDeadline';

let windowEvents: EventTarget;
let documentEvents: EventTarget;
let visibility: string;
const close = '2040-01-01T12:00:00.000Z';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.parse(close) - 1000));
  visibility = 'visible';
  windowEvents = new EventTarget();
  Object.assign(windowEvents, { setTimeout, clearTimeout });
  documentEvents = new EventTarget();
  Object.defineProperty(documentEvents, 'visibilityState', { get: () => visibility });
  vi.stubGlobal('window', windowEvents);
  vi.stubGlobal('document', documentEvents);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('switches exactly at closing without polling or a network response', () => {
  const update = vi.fn(), refresh = vi.fn();
  const stop = observeDeadline(close, update, refresh);
  expect(update).toHaveBeenLastCalledWith(false);
  vi.advanceTimersByTime(999);
  expect(update).toHaveBeenLastCalledWith(false);
  vi.advanceTimersByTime(1);
  expect(update).toHaveBeenLastCalledWith(true);
  expect(refresh).not.toHaveBeenCalled();
  stop();
});

it('rechecks a suspended deadline and refreshes when visible or focused, then removes listeners on cleanup', () => {
  const update = vi.fn(), refresh = vi.fn();
  const stop = observeDeadline(close, update, refresh);
  visibility = 'hidden';
  documentEvents.dispatchEvent(new Event('visibilitychange'));
  expect(refresh).not.toHaveBeenCalled();
  // Move wall time without firing the scheduled timer, as in a suspended tab.
  vi.setSystemTime(new Date(Date.parse(close) + 5000));
  visibility = 'visible';
  documentEvents.dispatchEvent(new Event('visibilitychange'));
  expect(update).toHaveBeenLastCalledWith(true);
  expect(refresh).toHaveBeenCalledTimes(1);
  windowEvents.dispatchEvent(new Event('focus'));
  expect(refresh).toHaveBeenCalledTimes(2);
  stop();
  windowEvents.dispatchEvent(new Event('focus'));
  documentEvents.dispatchEvent(new Event('visibilitychange'));
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('handles far-future deadlines without a timeout overflow or early closure', () => {
  const update = vi.fn();
  const stop = observeDeadline('2041-01-01T00:00:00Z', update, vi.fn());
  vi.advanceTimersByTime(2147483647);
  expect(update).toHaveBeenLastCalledWith(false);
  stop();
});
