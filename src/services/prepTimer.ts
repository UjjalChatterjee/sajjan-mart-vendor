/**
 * Food preparation timer.
 *
 * Single source of truth for the countdown is the server's
 * `preparationDueAt` — never a locally accumulated interval, so an app
 * restart, a background stint or a tab switch cannot drift the clock: every
 * render recomputes `dueAt - now` from absolute time.
 */

import type { Order, OrderItem } from '../types';

/* ── Selector bounds (mirrored by the backend clamp) ─────────────────── */

export const PREP_DEFAULT_MINUTES = 30;
export const PREP_MIN_MINUTES = 1;
export const PREP_MAX_MINUTES = 45;

/**
 * Anything unusable becomes the default rather than an error: the vendor must
 * never be blocked from accepting an order because of the selector.
 */
export function clampPreparationMinutes(value: unknown): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return PREP_DEFAULT_MINUTES;
  return Math.min(
    PREP_MAX_MINUTES,
    Math.max(PREP_MIN_MINUTES, Math.round(minutes)),
  );
}

/**
 * A food order is one with at least one active (non-cancelled) item marked
 * `food` — the same rule the backend applies before it stores a deadline.
 *
 * Two backend fields can carry that mark and both are honoured, because they
 * are written at different times: `order_items.item_type` is a snapshot taken
 * when the order was placed (and is NULL/`product` for rows that predate it),
 * while `order_items.product.product_type` is the live product record. Neither
 * is ever inferred from the item name.
 */
function isFoodMarker(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'food';
}

export function isFoodItem(item: OrderItem): boolean {
  return (
    item.cancelled !== true &&
    (isFoodMarker(item.itemType) || isFoodMarker(item.productType))
  );
}

export function isFoodOrder(order: Order | null | undefined): boolean {
  if (!order) return false;
  return (order.items ?? []).some(isFoodItem);
}

/** Statuses at which the kitchen is done: the countdown must stop there. */
const TERMINAL_STATUSES: string[] = ['delivered', 'cancelled', 'refunded'];

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Parse the instant an order is due; null when absent or unreadable. */
export function preparationDueMs(order: Order): number | null {
  const raw = order.preparationDueAt;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True while the order still owes kitchen time. Keyed on the stored deadline,
 * not on re-deriving food-ness: once the server stamped a due time, that is the
 * authority, and a later item cancellation must not erase the vendor's timer.
 */
export function showsPreparationTimer(order: Order): boolean {
  return !isTerminalStatus(order.status) && preparationDueMs(order) !== null;
}

export interface PreparationCountdown {
  /** `MM:SS`, `HH:MM:SS`, or `+MM:SS` / `+HH:MM:SS` once overdue. */
  label: string;
  /** Past the deadline — drives the red styling and the Late badge. */
  late: boolean;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${String(hours).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Remaining time at `nowMs`. The boundary is inclusive — at exactly the due
 * instant the order is already late — and the value goes negative from there,
 * which is what keeps overtime counting up without a separate accumulator.
 */
export function formatPreparationCountdown(
  dueMs: number,
  nowMs: number,
): PreparationCountdown {
  const diff = dueMs - nowMs;
  if (diff > 0) return { label: formatDuration(diff), late: false };
  return { label: `+${formatDuration(-diff)}`, late: true };
}
