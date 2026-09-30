/**
 * Food preparation timer.
 *
 * Single source of truth for the countdown is the server's
 * `preparationDueAt` — never a locally accumulated interval, so an app
 * restart, a background stint or a tab switch cannot drift the clock: every
 * render recomputes `dueAt - now` from absolute time.
 */

import type {
  BackendOrder,
  Order,
  OrderItem,
  PreparationSummary,
  PreparationTimerPatch,
} from '../types';

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

/**
 * Where the preparation clock is allowed to be live: the Processing tab. These
 * are the statuses `OrdersScreen.FIXED_TABS` maps to that tab, so an order
 * leaves the countdown the same moment it leaves the tab.
 */
const PROCESSING_STATUSES: string[] = ['accepted', 'confirmed', 'processing', 'packed'];

/**
 * The kitchen is finished: the duration freezes and is reported from the two
 * stored instants instead of counting. Mirrors the backend's
 * `KITCHEN_EXIT_STATUSES`, which is what stamps `prepared_at`.
 */
const KITCHEN_DONE_STATUSES: string[] = ['shipped', 'delivered'];

export function isProcessingStatus(status: string): boolean {
  return PROCESSING_STATUSES.includes(status);
}

export function isKitchenDoneStatus(status: string): boolean {
  return KITCHEN_DONE_STATUSES.includes(status);
}

/** Parse the instant an order is due; null when absent or unreadable. */
export function preparationDueMs(order: Order): number | null {
  const raw = order.preparationDueAt;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True while the order still owes kitchen time — and only inside Processing.
 * Keyed on the stored deadline, not on re-deriving food-ness: once the server
 * stamped a due time, that is the authority, and a later item cancellation must
 * not erase the vendor's timer.
 */
export function showsPreparationTimer(order: Order): boolean {
  return isProcessingStatus(order.status) && preparationDueMs(order) !== null;
}

/**
 * The preparation timer exactly as the accept response stated it, so the
 * Processing card can start counting the moment the accept comes back instead
 * of waiting for the order list to be fetched again — every second of that
 * window is time the kitchen already used and the countdown must still show.
 *
 * Only the fields the server owns, and only from the reply to the request for
 * *this* order. No device ever composes a deadline: an absent or unreadable one
 * patches nothing, leaving the stored value and the next refetch to reconcile.
 */
export function serverPreparationTimer(
  orderId: string,
  raw: BackendOrder | null | undefined,
): PreparationTimerPatch | null {
  if (!raw || raw.id !== orderId) return null;
  const due =
    typeof raw.preparation_due_at === 'string' ? raw.preparation_due_at : undefined;
  if (!due || !Number.isFinite(Date.parse(due))) return null;

  const accepted =
    typeof raw.accepted_at === 'string' && Number.isFinite(Date.parse(raw.accepted_at))
      ? raw.accepted_at
      : undefined;
  const minutes =
    typeof raw.preparation_time_minutes === 'number'
      ? raw.preparation_time_minutes
      : undefined;

  return {
    preparationDueAt: due,
    ...(accepted ? { acceptedAt: accepted } : null),
    ...(minutes === undefined ? null : { preparationTimeMinutes: minutes }),
  };
}

/** The frozen preparation result, as the backend computes and returns it. */
export type { PreparationSummary } from '../types';

/**
 * The exact difference, truncated to whole seconds.
 *
 * Minutes are deliberately not the unit here: rounding a part-minute up turned
 * a 1 minute order finished 5 seconds late into "Late by 1 min", and rounding it
 * down denied the lateness. Both told the vendor something that was not true.
 */
function secondsBetween(from: string | undefined, to: string | undefined): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 1000);
}

/**
 * The same two numbers the backend computes in `lib/order-preparation.ts`,
 * derived from the identical stored instants. Kept as the fallback for a row
 * that was fetched before that field existed, so an old cache can never invent
 * a duration of its own.
 */
export function derivePreparationSummary(order: Order): PreparationSummary | null {
  const actualSeconds = secondsBetween(order.acceptedAt, order.preparedAt);
  if (actualSeconds === null) return null;
  const overdue = secondsBetween(order.preparationDueAt, order.preparedAt);
  return { actualSeconds, lateSeconds: overdue ? overdue : null };
}

/**
 * The frozen preparation result of an order the kitchen has finished.
 *
 * Lateness is measured against the deadline the server stored, never against
 * `preparationTimeMinutes` — that number is what the vendor *asked for*, and
 * using it as the duration or the baseline is exactly how a late 1 minute
 * order came to read as "Prepared in 1 min". Nothing here reads the device
 * clock, so a restart, a refresh or a second phone derive the same numbers;
 * the server's own `preparation` object is preferred when present, because it
 * is what every device is meant to agree on. An order that finished before
 * `prepared_at` existed has no ready timestamp and therefore no summary —
 * `updated_at` is not a substitute and no value is invented.
 */
export function preparationSummary(order: Order): PreparationSummary | null {
  if (!isKitchenDoneStatus(order.status)) return null;

  const server = order.preparation;
  if (server && Number.isFinite(server.actualSeconds) && server.actualSeconds >= 0) {
    return {
      actualSeconds: server.actualSeconds,
      lateSeconds:
        typeof server.lateSeconds === 'number' && server.lateSeconds > 0
          ? server.lateSeconds
          : null,
    };
  }
  return derivePreparationSummary(order);
}

/** `45 sec`, `1 min`, `1 min 5 sec`, `2 min 5 sec` — never rounded to a minute. */
export function formatPreparationDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} sec`;
  if (rest === 0) return `${minutes} min`;
  return `${minutes} min ${rest} sec`;
}

export interface PreparationLabel {
  /** Normal-colour part: `Prepared in 1 min 5 sec`. */
  prepared: string;
  /** Red part, or null when the kitchen finished on time: `· Late by 5 sec`. */
  late: string | null;
}

/**
 * The frozen sentence, split so the lateness can be red while the duration stays
 * normal: `Prepared in 1 min 5 sec · Late by 5 sec`.
 */
export function preparationLabel(summary: PreparationSummary): PreparationLabel {
  return {
    prepared: `Prepared in ${formatPreparationDuration(summary.actualSeconds)}`,
    late:
      summary.lateSeconds === null
        ? null
        : `· Late by ${formatPreparationDuration(summary.lateSeconds)}`,
  };
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
