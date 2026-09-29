/**
 * Multi-device order-alert synchronization — verification suite.
 *
 *   npx jest __tests__/order-alert-sync.test.ts
 *
 * What this proves (JS level):
 *   A. one NEW_ORDER per order produces one alert; a delivery retry produces none.
 *   B. an ORDER_STATUS_UPDATED(ACCEPTED) push stops the sound, notifies the modal
 *      owner, cancels that order's notification and flips the query cache.
 *   C. same for REJECTED.
 *   D. a decision that arrives BEFORE the NEW_ORDER still suppresses the alert —
 *      an already handled order can never resurface as pending.
 *   E. an offline device that comes back reconciles: a decided order's stale
 *      alert is dismissed, a still-pending order's alert is kept, and a failed
 *      fetch invents nothing. Plus the 409 path (dismissStaleAlert), which reads
 *      the latest order state first.
 *   F. only the resolved order's notification is cancelled; another order's
 *      alert keeps ringing.
 *
 * What it cannot prove: real FCM delivery between two phones, the Android
 * notification tray, MediaPlayer playback and the foreground service. Those
 * need the rebuilt APK on at least two devices.
 */

/* ── Mocked native bridge ───────────────────────────────────────────────── */

const mockDismissNotification = jest.fn();
const mockStopOrderAlert = jest.fn();
const mockStartOrderAlert = jest.fn();

jest.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 34, select: (options: any) => options.android },
  NativeModules: {
    NotificationHelper: {
      dismissNotification: (...args: unknown[]) => mockDismissNotification(...args),
      stopOrderAlert: (...args: unknown[]) => mockStopOrderAlert(...args),
      startOrderAlert: (...args: unknown[]) => mockStartOrderAlert(...args),
      startForegroundSound: jest.fn(),
      stopForegroundSound: jest.fn(),
      setNotificationSoundEnabled: jest.fn(),
      getTappedOrderId: jest.fn(),
    },
  },
  DeviceEventEmitter: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  AppRegistry: {
    registerHeadlessTask: jest.fn(),
  },
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
    RESULTS: { GRANTED: 'granted', DENIED: 'denied' },
    request: jest.fn(async () => 'granted'),
  },
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

/* ── Mocked sound service: tests observe who owns the siren ─────────────── */

let mockAlertOwner: string | null = null;
const mockStopOrderAlertSound = jest.fn(() => {
  mockAlertOwner = null;
});

jest.mock('../src/services/sound.service', () => ({
  startOrderAlertSound: jest.fn((data: { orderId: string }) => {
    mockAlertOwner = data.orderId;
  }),
  stopOrderAlertSound: () => mockStopOrderAlertSound(),
  isOrderAlertPlaying: () => mockAlertOwner !== null,
  getActiveAlertOrderId: () => mockAlertOwner,
}));

/* ── Mocked order API (backend stand-in) ────────────────────────────────── */

const mockGetOrders = jest.fn();

jest.mock('../src/services/order.service', () => ({
  getOrders: (...args: unknown[]) => mockGetOrders(...args),
  acceptOrder: jest.fn(),
  rejectOrder: jest.fn(),
}));

/* notification.service pulls in Firebase + AsyncStorage. Neither is needed to
 * exercise its payload routing, and both ship as ESM that Jest cannot parse
 * under the React Native preset. */
jest.mock('@react-native-firebase/messaging', () => ({
  getMessaging: () => ({}),
  getToken: jest.fn(),
  onMessage: jest.fn(() => () => {}),
  onTokenRefresh: jest.fn(() => () => {}),
  onNotificationOpenedApp: jest.fn(() => () => {}),
  getInitialNotification: jest.fn(),
  setBackgroundMessageHandler: jest.fn(),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: jest.fn(async () => {}),
    getItem: jest.fn(async () => null),
    removeItem: jest.fn(async () => {}),
  },
}));

import * as alertSync from '../src/services/orderAlertSync';
import * as notificationService from '../src/services/notification.service';
import { queryClient } from '../src/services/queryClient';
import { ApiError } from '../src/services/api.client';
import type { Order } from '../src/types';

/* ── Fixtures ───────────────────────────────────────────────────────────── */

const ORDER_A = 'order-aaa';
const ORDER_B = 'order-bbb';

function makeOrder(id: string, status: string): Order {
  return {
    id,
    orderNumber: id.slice(-3),
    customerName: 'Customer',
    customerPhone: '0000000000',
    deliveryAddress: 'Address',
    status: status as Order['status'],
    items: [],
    subtotal: 100,
    discount: 0,
    deliveryCharge: 0,
    tax: 0,
    grandTotal: 100,
    createdAt: new Date().toISOString(),
  } as Order;
}

function newOrderPayload(orderId: string): Record<string, string> {
  return {
    type: 'NEW_ORDER',
    eventType: 'NEW_ORDER',
    eventId: `NEW_ORDER:${orderId}`,
    orderId,
    orderNumber: '1001',
    customerName: 'Customer',
    itemCount: '2',
    total: '250',
  };
}

function statusPayload(
  orderId: string,
  decision: 'ACCEPTED' | 'REJECTED',
): Record<string, string> {
  return {
    type: 'ORDER_STATUS_UPDATED',
    eventType: 'ORDER_STATUS_UPDATED',
    eventId: `ORDER_STATUS_UPDATED:${orderId}:${decision}`,
    orderId,
    status: decision,
    decision,
  };
}

/* ── Setup / teardown ───────────────────────────────────────────────────── */

beforeEach(() => {
  jest.clearAllMocks();
  mockAlertOwner = null;
  queryClient.clear();
  alertSync.resetOrderAlertState();
});

describe('A — one alert per order, repeats suppressed', () => {
  it('claims the first NEW_ORDER and rejects the delivery retry', () => {
    const onIncoming = jest.fn();
    notificationService.setIncomingOrderHandler(onIncoming);

    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'foreground');
    expect(alertSync.isAlertActive(ORDER_A)).toBe(true);
    expect(onIncoming).toHaveBeenCalledTimes(1);

    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'foreground');
    expect(onIncoming).toHaveBeenCalledTimes(1);

    // A different order is a separate alert
    notificationService.routeOrderEventData(newOrderPayload(ORDER_B), 'foreground');
    expect(onIncoming).toHaveBeenCalledTimes(2);

    notificationService.removeIncomingOrderHandler();
  });

  it('keeps one registry entry per order', () => {
    expect(alertSync.claimNewOrderAlert(ORDER_A)).toBe(true);
    expect(alertSync.claimNewOrderAlert(ORDER_A)).toBe(false);
    expect(alertSync.activeAlertsSnapshot().map(alert => alert.orderId)).toEqual([
      ORDER_A,
    ]);
  });
});

describe('B/C — a remote decision cleans this device up', () => {
  beforeEach(() => {
    queryClient.setQueryData<Order[]>(['orders'], [makeOrder(ORDER_A, 'pending')]);
    alertSync.claimNewOrderAlert(ORDER_A);
    mockAlertOwner = ORDER_A;
  });

  it.each([
    ['ACCEPTED', 'confirmed'],
    ['REJECTED', 'cancelled'],
  ] as const)(
    'ORDER_STATUS_UPDATED %s → sound, modal, notification, cache',
    (decision, expected) => {
      const decisions: Array<[string, Order['status'] | null]> = [];
      const unsubscribe = alertSync.subscribeOrderDecisions((id, status) =>
        decisions.push([id, status]),
      );

      notificationService.routeOrderEventData(
        statusPayload(ORDER_A, decision),
        'foreground',
      );
      unsubscribe();

      // 1/2 — the siren belonged to this order, so it stops
      expect(mockStopOrderAlertSound).toHaveBeenCalledTimes(1);
      expect(mockStopOrderAlert).toHaveBeenCalledTimes(1);
      // 3 — the modal owner is told about exactly this order and status
      expect(decisions).toEqual([[ORDER_A, expected]]);
      // 4 — the notification is cancelled by this order's id only
      expect(mockDismissNotification).toHaveBeenCalledTimes(1);
      expect(mockDismissNotification).toHaveBeenCalledWith(ORDER_A);
      // 5 — the cached row flips without waiting for a refetch
      const cached = queryClient.getQueryData<Order[]>(['orders']) ?? [];
      expect(cached[0].status).toBe(expected);
      // 6 — the order can never be shown as pending again
      expect(alertSync.isAlertActive(ORDER_A)).toBe(false);
      expect(alertSync.claimNewOrderAlert(ORDER_A)).toBe(false);

      // a duplicate push stays harmless
      alertSync.applyOrderDecision(ORDER_A, decision);
      expect(mockDismissNotification).toHaveBeenCalledTimes(2);
      expect(
        (queryClient.getQueryData<Order[]>(['orders']) ?? [])[0].status,
      ).toBe(expected);
    },
  );

  it('still routes a payload that only carries the legacy `type` key', () => {
    const payload = statusPayload(ORDER_A, 'ACCEPTED');
    delete payload.eventType;
    notificationService.routeOrderEventData(payload, 'foreground');
    expect(mockDismissNotification).toHaveBeenCalledWith(ORDER_A);
  });
});

describe('D — the status push can win the race', () => {
  it('never re-alerts an order decided before its NEW_ORDER arrived', () => {
    const onIncoming = jest.fn();
    notificationService.setIncomingOrderHandler(onIncoming);

    notificationService.routeOrderEventData(
      statusPayload(ORDER_A, 'ACCEPTED'),
      'foreground',
    );
    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'foreground');

    expect(onIncoming).not.toHaveBeenCalled();
    expect(alertSync.isAlertActive(ORDER_A)).toBe(false);
    notificationService.removeIncomingOrderHandler();
  });
});

describe('E — offline device reconciles on the way back', () => {
  it('dismisses an alert whose order was decided while offline', async () => {
    alertSync.claimNewOrderAlert(ORDER_A);
    mockAlertOwner = ORDER_A;
    mockGetOrders.mockResolvedValue([makeOrder(ORDER_A, 'confirmed')]);

    await expect(alertSync.reconcileAlertsWithBackend()).resolves.toBe(1);
    expect(mockStopOrderAlertSound).toHaveBeenCalledTimes(1);
    expect(mockDismissNotification).toHaveBeenCalledWith(ORDER_A);
    expect(alertSync.claimNewOrderAlert(ORDER_A)).toBe(false);
  });

  it('keeps alerting an order that is still pending', async () => {
    alertSync.claimNewOrderAlert(ORDER_A);
    mockGetOrders.mockResolvedValue([makeOrder(ORDER_A, 'pending')]);

    await expect(alertSync.reconcileAlertsWithBackend()).resolves.toBe(0);
    expect(mockStopOrderAlertSound).not.toHaveBeenCalled();
    expect(mockDismissNotification).not.toHaveBeenCalled();
    expect(alertSync.isAlertActive(ORDER_A)).toBe(true);
  });

  it('a failed fetch changes nothing — no decision is invented', async () => {
    alertSync.claimNewOrderAlert(ORDER_A);
    mockGetOrders.mockRejectedValue(new ApiError(500, 'server error'));

    await expect(alertSync.reconcileAlertsWithBackend()).resolves.toBe(0);
    expect(alertSync.isAlertActive(ORDER_A)).toBe(true);
    expect(mockDismissNotification).not.toHaveBeenCalled();
  });

  it('uses a list the caller already fetched instead of a second request', async () => {
    alertSync.claimNewOrderAlert(ORDER_A);

    const dismissed = await alertSync.reconcileAlertsWithBackend([
      makeOrder(ORDER_A, 'cancelled'),
    ]);

    expect(dismissed).toBe(1);
    expect(mockGetOrders).not.toHaveBeenCalled();
  });

  it('an order missing from the backend list keeps alerting', async () => {
    alertSync.claimNewOrderAlert(ORDER_A);
    mockGetOrders.mockResolvedValue([makeOrder(ORDER_B, 'confirmed')]);

    await expect(alertSync.reconcileAlertsWithBackend()).resolves.toBe(0);
    expect(alertSync.isAlertActive(ORDER_A)).toBe(true);
  });

  it('a 409 closes the stale alert using the latest state from the server', async () => {
    alertSync.claimNewOrderAlert(ORDER_A);
    mockAlertOwner = ORDER_A;
    queryClient.setQueryData<Order[]>(['orders'], [makeOrder(ORDER_A, 'pending')]);
    mockGetOrders.mockResolvedValue([makeOrder(ORDER_A, 'cancelled')]);

    await alertSync.dismissStaleAlert(ORDER_A);

    expect(mockGetOrders).toHaveBeenCalledTimes(1);
    expect(mockDismissNotification).toHaveBeenCalledWith(ORDER_A);
    const cached = queryClient.getQueryData<Order[]>(['orders']) ?? [];
    expect(cached[0].status).toBe('cancelled');
    expect(alertSync.claimNewOrderAlert(ORDER_A)).toBe(false);
  });

  it('a 409 whose status cannot be read still closes the alert', async () => {
    alertSync.claimNewOrderAlert(ORDER_A);
    queryClient.setQueryData<Order[]>(['orders'], [makeOrder(ORDER_A, 'pending')]);
    mockGetOrders.mockRejectedValue(new ApiError(0, 'offline'));

    await alertSync.dismissStaleAlert(ORDER_A);

    expect(alertSync.isAlertActive(ORDER_A)).toBe(false);
    expect(mockDismissNotification).toHaveBeenCalledWith(ORDER_A);
    // No invented status was written into the cache
    const cached = queryClient.getQueryData<Order[]>(['orders']) ?? [];
    expect(cached[0].status).toBe('pending');
  });
});

describe('F — another order keeps its alert', () => {
  it('deciding one order leaves the other ringing and untouched', () => {
    alertSync.claimNewOrderAlert(ORDER_A);
    alertSync.claimNewOrderAlert(ORDER_B);
    mockAlertOwner = ORDER_B; // the siren belongs to the still-pending order

    alertSync.applyOrderDecision(ORDER_A, 'ACCEPTED');

    expect(mockStopOrderAlertSound).not.toHaveBeenCalled();
    expect(mockStopOrderAlert).not.toHaveBeenCalled();
    expect(mockDismissNotification).toHaveBeenCalledTimes(1);
    expect(mockDismissNotification).toHaveBeenCalledWith(ORDER_A);
    expect(alertSync.isAlertActive(ORDER_B)).toBe(true);
    expect(mockAlertOwner).toBe(ORDER_B);
  });

  it('the last decided order does stop an orphaned siren', () => {
    alertSync.claimNewOrderAlert(ORDER_A);
    mockAlertOwner = ORDER_B; // nothing left to ring for

    alertSync.applyOrderDecision(ORDER_A, 'REJECTED');

    expect(mockStopOrderAlertSound).toHaveBeenCalledTimes(1);
  });
});

describe('background routing', () => {
  it('a background NEW_ORDER rings once and never for a decided order', () => {
    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'background');
    expect(alertSync.isAlertActive(ORDER_A)).toBe(true);

    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'background');
    expect(alertSync.isAlertActive(ORDER_A)).toBe(true);

    notificationService.routeOrderEventData(
      statusPayload(ORDER_A, 'ACCEPTED'),
      'background',
    );
    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'background');
    expect(alertSync.isAlertActive(ORDER_A)).toBe(false);
  });

  it('a background status update cleans up without a mounted screen', () => {
    alertSync.claimNewOrderAlert(ORDER_A);
    notificationService.routeOrderEventData(
      statusPayload(ORDER_A, 'REJECTED'),
      'background',
    );
    expect(mockDismissNotification).toHaveBeenCalledWith(ORDER_A);
    expect(alertSync.claimNewOrderAlert(ORDER_A)).toBe(false);
  });
});

describe('sign-out isolation', () => {
  it('a new session does not inherit decided orders', () => {
    alertSync.applyOrderDecision(ORDER_A, 'ACCEPTED');
    notificationService.resetNotificationInitialization();

    expect(alertSync.claimNewOrderAlert(ORDER_A)).toBe(true);
  });
});
