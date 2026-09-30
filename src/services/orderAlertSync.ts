/**
 * Multi-device order-alert synchronization.
 *
 * Backend side of the contract (sajjan-mart):
 *   - Only one device can move an order out of `pending`. The winner gets 200,
 *     every other attempt gets HTTP 409 with the live status and the row is
 *     never overwritten.
 *   - The winner fans an ORDER_STATUS_UPDATED push out to every active admin
 *     device token — including the device that acted, so cleanup is one code path.
 *
 * This module is the JS side of that contract. It owns:
 *   1. the in-memory set of alerts this device is currently showing (so a
 *      delivery retry or a buffered replay can never start a second sound),
 *   2. the set of orders this device already knows are decided (a decided order
 *      must never resurface as pending, even if its NEW_ORDER push lands after
 *      the status push),
 *   3. the local cleanup applied when an order is decided — stop this order's
 *      sound and repeating vibration, close its modal (via subscribers), cancel
 *      its notification by the order-derived id, and patch the ['orders'] cache.
 *
 * Notification cancellation deliberately goes through the native
 * `dismissNotification(orderId)` bridge, which cancels the deterministic
 * `0x7FFFFFFF and orderId.hashCode()` id used by BOTH the JS-posted and the
 * OrderAlertService-posted notification. There is no cancel-all path here, so
 * notifications belonging to other orders or other apps are never touched.
 */

import { NativeModules, Platform } from 'react-native';
import { queryClient } from './queryClient';
import { getOrders } from './order.service';
import { getActiveAlertOrderId, stopOrderAlertSound } from './sound.service';
import {
  getVibratingOrderId,
  startOrderVibration,
  stopOrderVibration,
} from './orderVibration';
import type { Order, OrderStatus } from '../types';

/* ── Types ── */

export interface ActiveOrderAlert {
  orderId: string;
  orderNumber?: string;
}

/** Called for every decided order, remote or local. `status` is null when the
 *  decision is known but its value has to come from the next refetch. */
export type OrderDecisionListener = (
  orderId: string,
  status: OrderStatus | null,
) => void;

/* ── Constants ── */

const ORDER_QUERY_KEY = ['orders'];

/** Bound the registries so a long-lived session cannot grow without limit. */
const REGISTRY_LIMIT = 50;

/** Wire vocabulary from lib/notifications.ts → app OrderStatus. */
const WIRE_TO_ORDER_STATUS: Record<string, OrderStatus> = {
  ACCEPTED: 'confirmed',
  REJECTED: 'cancelled',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  ACCEPT: 'confirmed',
  REJECT: 'cancelled',
};

/** Statuses the app understands — anything else is treated as unknown. */
const KNOWN_ORDER_STATUSES = new Set<string>([
  'pending',
  'accepted',
  'rejected',
  'confirmed',
  'processing',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'cancel_request',
  'return',
  'refunded',
]);

/** Statuses that still justify a pending NEW_ORDER alert. */
function isStillAwaitingDecision(status: OrderStatus | string): boolean {
  return status === 'pending';
}

/* ── State ── */

const activeAlerts = new Map<string, ActiveOrderAlert>();
/** orderId → decided status, or null when the order is known to be decided but
 *  this device does not know the value yet (409 with an unread status). */
const decidedOrders = new Map<string, OrderStatus | null>();
const listeners = new Set<OrderDecisionListener>();

const NativeBridge =
  Platform.OS === 'android'
    ? (NativeModules.NotificationHelper as
        | {
            dismissNotification(orderId: string): void;
            stopOrderAlert(): void;
          }
        | undefined)
    : undefined;

/* ── Registry ── */

/** Whether this device is currently alerting for the order. */
export function isAlertActive(orderId: string): boolean {
  return activeAlerts.has(orderId);
}

/** Whether the order is already known to be decided (accepted/rejected/…). */
export function decidedStatusFor(orderId: string): OrderStatus | null {
  return decidedOrders.get(orderId) ?? null;
}

export function activeAlertsSnapshot(): ActiveOrderAlert[] {
  return [...activeAlerts.values()];
}

/**
 * Claim an incoming NEW_ORDER for alerting on this device.
 *
 * Returns true only for the first delivery of an undecided order. false means
 * "already alerting" or "already decided", and the caller must not open a
 * modal or start the alert sound.
 */
export function claimNewOrderAlert(
  orderId: string | undefined | null,
  orderNumber?: string,
): boolean {
  if (!orderId) return false;
  if (decidedOrders.has(orderId)) {
    if (__DEV__) {
      console.log(
        `[ALERT-SYNC] NEW_ORDER ignored — order ${orderId} is already decided`,
      );
    }
    return false;
  }
  if (activeAlerts.has(orderId)) {
    if (__DEV__) {
      console.log(`[ALERT-SYNC] Duplicate NEW_ORDER ignored for order ${orderId}`);
    }
    return false;
  }

  activeAlerts.set(orderId, { orderId, orderNumber });
  if (activeAlerts.size > REGISTRY_LIMIT) {
    const oldest = activeAlerts.keys().next().value;
    if (oldest !== undefined) activeAlerts.delete(oldest);
  }
  return true;
}

/** Forget every tracked alert and decision (sign-out / test isolation). */
export function resetOrderAlertState(): void {
  stopOrderVibration();
  activeAlerts.clear();
  decidedOrders.clear();
}

/* ── Subscriptions ── */

export function subscribeOrderDecisions(
  listener: OrderDecisionListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ── Helpers ── */

/** Wire status → app status. Returns null for a blank/unrecognised value so a
 *  caller that only knows "this order is decided" never writes a guessed
 *  status into the cache. */
export function toOrderStatus(rawStatus: string | undefined | null): OrderStatus | null {
  const key = String(rawStatus ?? '').trim().toUpperCase();
  if (!key) return null;
  const mapped = WIRE_TO_ORDER_STATUS[key];
  if (mapped) return mapped;
  const lowered = key.toLowerCase() as OrderStatus;
  return KNOWN_ORDER_STATUSES.has(lowered) ? lowered : null;
}

/** Cancel exactly one order's notification, by its deterministic id. */
function cancelOrderNotification(orderId: string): void {
  if (!NativeBridge?.dismissNotification) return;
  try {
    NativeBridge.dismissNotification(orderId);
  } catch (error) {
    if (__DEV__) {
      console.warn(
        '[ALERT-SYNC] Failed to cancel order notification:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * Move the cached order row to its decided status without waiting for a refetch
 * (when the status is known), then invalidate so the list reconciles with the
 * backend.
 */
function patchOrdersCache(orderId: string, status: OrderStatus | null): void {
  if (status) {
    queryClient.setQueryData<Order[]>(ORDER_QUERY_KEY, prev =>
      prev
        ? prev.map(order =>
            order.id === orderId ? { ...order, status } : order,
          )
        : prev,
    );
  }
  queryClient.invalidateQueries({ queryKey: ORDER_QUERY_KEY });
}

/* ── Core cleanup ── */

/**
 * Apply a decision for an order on this device — this is the single cleanup
 * path used by the remote ORDER_STATUS_UPDATED push, by this device's own
 * successful Accept/Reject, and by the resume reconciliation.
 *
 * Idempotent: repeat calls stop at the same end state (sound off, modal closed,
 * notification cancelled, order recorded as decided).
 */
export function applyOrderDecision(
  orderId: string | undefined | null,
  rawStatus?: string | OrderStatus | null,
): void {
  if (!orderId) return;

  const status = toOrderStatus(rawStatus);

  decidedOrders.set(orderId, status);
  if (decidedOrders.size > REGISTRY_LIMIT) {
    const oldest = decidedOrders.keys().next().value;
    if (oldest !== undefined) decidedOrders.delete(oldest);
  }
  activeAlerts.delete(orderId);

  // Stop audio only when it belongs to this order, or when nothing is left to
  // ring for. A second order's alert is never silenced by the first one's
  // decision.
  const soundBelongsToOrder = getActiveAlertOrderId() === orderId;
  if (soundBelongsToOrder || activeAlerts.size === 0) {
    stopOrderAlertSound();
  }
  if (soundBelongsToOrder && NativeBridge?.stopOrderAlert) {
    try {
      NativeBridge.stopOrderAlert();
    } catch {
      // The service may already be stopped — nothing to clean up.
    }
  }

  // Same ownership rule for the repeating vibration: silence it only when this
  // order owns the loop or nothing else is alerting. When another order is still
  // pending, the loop is re-targeted instead of stopped, so the vendor keeps
  // feeling one continuous alert and never a gap.
  const vibrationBelongsToOrder = getVibratingOrderId() === orderId;
  if (vibrationBelongsToOrder || activeAlerts.size === 0) {
    const nextAlert = activeAlertsSnapshot()[0];
    if (nextAlert) startOrderVibration(nextAlert.orderId);
    else stopOrderVibration();
  }

  cancelOrderNotification(orderId);
  patchOrdersCache(orderId, status);

  listeners.forEach(listener => {
    try {
      listener(orderId, status);
    } catch (error) {
      console.warn(
        '[ALERT-SYNC] Decision listener failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  if (__DEV__) {
    console.log(
      `[ALERT-SYNC] Order ${orderId} resolved${status ? ` as ${status}` : ' (status from next refetch)'}`,
    );
  }
}

/* ── Reconciliation ── */

/**
 * Reconcile this device's pending alerts against authoritative backend status —
 * for the offline device that missed one or more pushes and is now back. Any
 * alert whose order is no longer pending is dismissed; a network failure
 * changes nothing, so alerts survive until the next attempt instead of being
 * silently dropped.
 *
 * `orders` may be passed when the caller already holds a fresh list (e.g. the
 * order query just refetched) — no request is then made and no invalidate is
 * issued, because the caller's data is the reconciliation source.
 *
 * Returns the number of stale alerts dismissed.
 */
export async function reconcileAlertsWithBackend(
  orders?: Order[],
): Promise<number> {
  const pendingIds = [...activeAlerts.keys()];
  if (pendingIds.length === 0) return 0;

  let latest = orders;
  if (!latest) {
    try {
      latest = await getOrders();
    } catch (error) {
      if (__DEV__) {
        console.log(
          '[ALERT-SYNC] Reconciliation skipped — order fetch failed:',
          error instanceof Error ? error.message : String(error),
        );
      }
      return 0;
    }
  }

  let dismissed = 0;
  pendingIds.forEach(orderId => {
    const order = latest!.find(item => item.id === orderId);
    // Not in the list yet (or filtered out) — keep alerting, the push or the
    // next reconciliation will settle it.
    if (!order) return;
    if (isStillAwaitingDecision(order.status)) return;
    applyOrderDecision(orderId, order.status);
    dismissed += 1;
  });

  if (__DEV__ && dismissed > 0) {
    console.log(
      `[ALERT-SYNC] Reconciliation dismissed ${dismissed} stale alert(s)`,
    );
  }
  return dismissed;
}

/**
 * Dismiss this device's alert for an order the backend just rejected as already
 * decided (HTTP 409 from the atomic pending-exit transition). The latest order
 * state is fetched first so the alert is closed with the real status; if that
 * fetch fails the alert is still closed, because the 409 itself is the proof
 * the order is no longer pending.
 */
export async function dismissStaleAlert(orderId: string): Promise<void> {
  let status: string | null = null;
  try {
    const orders = await getOrders();
    status = orders.find(item => item.id === orderId)?.status ?? null;
  } catch (error) {
    if (__DEV__) {
      console.log(
        '[ALERT-SYNC] Stale-alert status lookup failed — closing without a status:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  applyOrderDecision(orderId, status ?? undefined);
}
