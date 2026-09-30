/**
 * Phase 9 BUG 1 — the order cache gets the deadline from the accept reply.
 *
 *   npx jest __tests__/food-preparation-accept-cache.test.ts
 *
 * The Processing card used to learn `preparation_due_at` only when the order
 * list happened to be fetched again, because the accept response — which
 * already carries the deadline the server just stamped — was discarded. These
 * tests cover the cache half of that fix: the row a card renders from is the
 * row the server answered with.
 *
 * What they cannot prove: the wall-clock delay of a real fetch on a real phone.
 */

/* ── Mocked native bridge ───────────────────────────────────────────────── */

const mockDismissNotification = jest.fn();
const mockStopOrderAlert = jest.fn();

jest.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 34, select: (options: any) => options.android },
  NativeModules: {
    NotificationHelper: {
      dismissNotification: (...args: unknown[]) => mockDismissNotification(...args),
      stopOrderAlert: (...args: unknown[]) => mockStopOrderAlert(...args),
      startOrderAlert: jest.fn(),
      startForegroundSound: jest.fn(),
      stopForegroundSound: jest.fn(),
      setNotificationSoundEnabled: jest.fn(),
      getTappedOrderId: jest.fn(),
    },
  },
  DeviceEventEmitter: { addListener: jest.fn(() => ({ remove: jest.fn() })) },
  AppRegistry: { registerHeadlessTask: jest.fn() },
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

jest.mock('../src/services/sound.service', () => ({
  startOrderAlertSound: jest.fn(),
  stopOrderAlertSound: jest.fn(),
  isOrderAlertPlaying: () => false,
  getActiveAlertOrderId: () => null,
}));

/* The REST layer is a stand-in: these tests are about what this device keeps
 * after a successful accept, not about the network. */
jest.mock('../src/services/order.service', () => ({
  getOrders: jest.fn(async () => []),
  acceptOrder: jest.fn(async () => null),
  rejectOrder: jest.fn(async () => {}),
}));

jest.mock('../src/services/api.client', () => ({
  apiPut: jest.fn(async () => ({})),
  apiGet: jest.fn(async () => []),
  apiPost: jest.fn(async () => ({})),
  ApiError: class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { applyOrderDecision } from '../src/services/orderAlertSync';
import { queryClient } from '../src/services/queryClient';
import { showsPreparationTimer } from '../src/services/prepTimer';
import type { Order, PreparationTimerPatch } from '../src/types';

const ORDER_ID = 'order-prep-1';
const ACCEPTED_AT = '2026-09-30T14:00:00.000Z';
const DUE_AT = '2026-09-30T14:01:00.000Z';

function pendingFoodOrder(): Order {
  return {
    id: ORDER_ID,
    orderNumber: '2001',
    customerName: 'Ravi',
    customerPhone: '9000000000',
    deliveryAddress: 'Somewhere',
    items: [
      {
        id: 'i1',
        name: 'Paneer Curry',
        quantity: 1,
        price: 250,
        total: 250,
        ready: false,
        cancelled: false,
        itemType: 'food',
      },
    ],
    status: 'pending',
    subtotal: 250,
    discount: 0,
    deliveryCharge: 0,
    tax: 0,
    grandTotal: 250,
    createdAt: '2026-09-30T13:55:00.000Z',
  };
}

const cached = () =>
  (queryClient.getQueryData<Order[]>(['orders']) ?? []).find(o => o.id === ORDER_ID)!;

describe('the accept reply puts the deadline in the cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryClient.setQueryData<Order[]>(['orders'], [pendingFoodOrder()]);
  });

  it('the row the card renders from carries the server deadline straight away', () => {
    // Before the decision the order has no timer at all — it is still pending.
    expect(showsPreparationTimer(cached())).toBe(false);

    const timer: PreparationTimerPatch = {
      preparationTimeMinutes: 1,
      acceptedAt: ACCEPTED_AT,
      preparationDueAt: DUE_AT,
    };
    applyOrderDecision(ORDER_ID, 'ACCEPTED', timer);

    const row = cached();
    expect(row.status).toBe('confirmed');
    expect(row.preparationDueAt).toBe(DUE_AT);
    expect(row.acceptedAt).toBe(ACCEPTED_AT);
    expect(row.preparationTimeMinutes).toBe(1);
    // No list fetch in between: the Processing card can already count down.
    expect(showsPreparationTimer(row)).toBe(true);
  });

  it('a decision with no timer patch leaves the stored deadline untouched', () => {
    applyOrderDecision(ORDER_ID, 'ACCEPTED', {
      preparationTimeMinutes: 1,
      acceptedAt: ACCEPTED_AT,
      preparationDueAt: DUE_AT,
    });

    // A later push/reconcile cleanup for the same order must not reset it.
    applyOrderDecision(ORDER_ID, 'ACCEPTED');

    expect(cached().preparationDueAt).toBe(DUE_AT);
  });

  it('another order is never touched by this order decision', () => {
    const other: Order = { ...pendingFoodOrder(), id: 'order-other', orderNumber: '2002' };
    queryClient.setQueryData<Order[]>(['orders'], [pendingFoodOrder(), other]);

    applyOrderDecision(ORDER_ID, 'ACCEPTED', { preparationDueAt: DUE_AT });

    const untouched = (queryClient.getQueryData<Order[]>(['orders']) ?? []).find(
      o => o.id === 'order-other',
    )!;
    expect(untouched.status).toBe('pending');
    expect(untouched.preparationDueAt).toBeUndefined();
  });

  it('an order that is not in the cache is not invented into it', () => {
    queryClient.setQueryData<Order[]>(['orders'], []);

    applyOrderDecision('order-unknown', 'ACCEPTED', { preparationDueAt: DUE_AT });

    expect(queryClient.getQueryData<Order[]>(['orders'])).toEqual([]);
  });
});
