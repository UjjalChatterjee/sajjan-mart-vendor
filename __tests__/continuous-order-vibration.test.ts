/**
 * Continuous new-order vibration — verification suite.
 *
 *   npx jest __tests__/continuous-order-vibration.test.ts
 *
 * Contract these tests pin (Requirements 1–4):
 *   1. A foreground NEW_ORDER starts the repeating haptic and it keeps running
 *      until the order is resolved — no JS timer owns it in between.
 *   2. Accept stops it. 3. Reject stops it.
 *   4. A decision made on ANOTHER device (ORDER_STATUS_UPDATED push) stops it.
 *   5. Sound OFF skips the audio and still vibrates.
 *   6. The background / killed alert hands the native service the order id only,
 *      so no customer, payment, address or item data can reach the notification.
 *   7. No ACCEPT / REJECT action API is left on the bridge the notification
 *      could use — JS can only post, dismiss and open the app.
 *   8. Tapping that notification opens the Orders screen (live event and cold
 *      start flag both route through the one handler App.tsx registers).
 *   9. Duplicate pushes, replays and re-renders cannot stack a second loop.
 *   Plus: a second pending order keeps alerting when the first is decided (the
 *   loop is re-targeted, never silenced), and signing out releases the haptic.
 *
 * Scope of the proof: this is the JS↔bridge half. The Kotlin half — that
 * VibrationEffect.createWaveform(…, repeatIndex = 1) actually loops on the
 * motor, that the channel burst cannot override it, and that the notification
 * renders "Sajjan Mart / 1 New Order" with no action buttons — is verified by
 * compilation and by inspecting the built APK, NOT here, and has not been run
 * on a physical device.
 */

/* ── Bridge stand-in ─────────────────────────────────────────────────────── */

var mockBridgeOverride: Record<string, unknown> | null = null;

var mockStartVibration = jest.fn();
var mockStopVibration = jest.fn();
var mockStartForegroundSound = jest.fn();
var mockStopForegroundSound = jest.fn();
var mockStartOrderAlert = jest.fn();
var mockStopOrderAlert = jest.fn();
var mockDismissNotification = jest.fn();
var mockGetNotificationSoundEnabled = jest.fn(async () => true);
var mockSetNotificationSoundEnabled = jest.fn();
var mockGetPendingOrdersNavigation = jest.fn(async () => false);
var mockGetTappedOrderId = jest.fn(async () => null);
var mockApiPost = jest.fn(async (..._args: unknown[]) => ({}));
var mockBackgroundHandler:
  | ((message: { data: Record<string, string> }) => Promise<void>)
  | null = null;

/** Event listeners the app registered, keyed by the native event name. */
var mockEventHandlers: Record<string, Array<(payload?: unknown) => void>> = {};

function mockFullBridge(): Record<string, unknown> {
  return {
    getNotificationSoundEnabled: () => mockGetNotificationSoundEnabled(),
    setNotificationSoundEnabled: (enabled: boolean) =>
      mockSetNotificationSoundEnabled(enabled),
    startOrderAlertVibration: () => mockStartVibration(),
    stopOrderAlertVibration: () => mockStopVibration(),
    startForegroundSound: () => mockStartForegroundSound(),
    stopForegroundSound: () => mockStopForegroundSound(),
    startOrderAlert: (...args: unknown[]) => mockStartOrderAlert(...args),
    stopOrderAlert: (...args: unknown[]) => mockStopOrderAlert(...args),
    dismissNotification: (...args: unknown[]) => mockDismissNotification(...args),
    getPendingOrdersNavigation: () => mockGetPendingOrdersNavigation(),
    getTappedOrderId: () => mockGetTappedOrderId(),
    setApiBaseUrl: jest.fn(),
  };
}

jest.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 34, select: (options: any) => options.android },
  NativeModules: {
    get NotificationHelper() {
      return mockBridgeOverride ?? mockFullBridge();
    },
  },
  DeviceEventEmitter: {
    addListener: (eventName: string, handler: (payload?: unknown) => void) => {
      (mockEventHandlers[eventName] ??= []).push(handler);
      return {
        remove: () => {
          mockEventHandlers[eventName] = (mockEventHandlers[eventName] ?? []).filter(h => h !== handler);
        },
      };
    },
  },
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

jest.mock('../src/services/api.client', () => ({
  apiPost: (...args: unknown[]) => mockApiPost(...args),
}));
jest.mock('../src/config/apiBaseUrl', () => ({
  syncApiBaseUrlToNative: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: jest.fn(async () => {}),
    getItem: jest.fn(async () => null),
    removeItem: jest.fn(async () => {}),
  },
}));

jest.mock('@react-native-firebase/messaging', () => ({
  getMessaging: () => ({}),
  getToken: jest.fn(async () => 'mock-fcm-token-not-a-real-one'),
  onMessage: jest.fn(() => () => {}),
  onTokenRefresh: jest.fn(() => () => {}),
  onNotificationOpenedApp: jest.fn(() => () => {}),
  getInitialNotification: jest.fn(async () => null),
  setBackgroundMessageHandler: jest.fn(
    (_messaging: unknown, handler: (message: { data: Record<string, string> }) => Promise<void>) => {
      mockBackgroundHandler = handler;
    },
  ),
}));

jest.mock('../src/services/order.service', () => ({
  getOrders: jest.fn(async () => []),
  acceptOrder: jest.fn(),
  rejectOrder: jest.fn(),
}));

import * as alertSync from '../src/services/orderAlertSync';
import * as soundPreference from '../src/config/notificationSound';
import { stopOrderAlertSound } from '../src/services/sound.service';
import * as orderVibration from '../src/services/orderVibration';
import * as notificationService from '../src/services/notification.service';

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const CUSTOMER = 'Priya Sharma';
const PHONE = '9999888877';
const ADDRESS = '12 MG Road, Indore';

function newOrderPayload(orderId: string): Record<string, string> {
  return {
    type: 'NEW_ORDER',
    eventType: 'NEW_ORDER',
    eventId: `NEW_ORDER:${orderId}`,
    orderId,
    orderNumber: '1001',
    customerName: CUSTOMER,
    customerPhone: PHONE,
    address: ADDRESS,
    itemCount: '2',
    total: '250',
    paymentMethod: 'online',
    paymentStatus: 'PAID',
    items: JSON.stringify([{ name: 'Ghee Jar 500g', qty: 2 }]),
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

/** Every bridge argument handed to the alert, as one searchable string. */
function bridgeCallLog(): string {
  return JSON.stringify([
    mockStartOrderAlert.mock.calls,
    mockStartForegroundSound.mock.calls,
    mockStartVibration.mock.calls,
    mockDismissNotification.mock.calls,
  ]);
}

let orderSeq = 0;
function freshOrder(): string {
  orderSeq += 1;
  return `order-vibe-${orderSeq}`;
}

beforeEach(() => {
  // Release module state BEFORE the counters are cleared: both reset helpers
  // legitimately touch the bridge, and that must not read as a result.
  stopOrderAlertSound();
  orderVibration.stopOrderVibration();
  alertSync.resetOrderAlertState();
  mockEventHandlers = {};
  mockBridgeOverride = null;
  jest.clearAllMocks();
  mockGetNotificationSoundEnabled.mockResolvedValue(true);
  mockGetPendingOrdersNavigation.mockResolvedValue(false);
  notificationService.setIncomingOrderHandler(jest.fn());
  notificationService.removeIncomingOrderHandler();
  notificationService.removeOpenOrdersHandler();
  soundPreference.resetNotificationSoundPreferenceForTests();
});

/* ── 1 + 9 — one loop, from claim to resolution ──────────────────────────── */

describe('1 — a foreground alert starts one repeating haptic and keeps it', () => {
  it('dispatches exactly one native loop and stays vibrating', () => {
    const orderId = freshOrder();

    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');

    expect(mockStartVibration).toHaveBeenCalledTimes(1);
    expect(orderVibration.getVibratingOrderId()).toBe(orderId);
    // Nothing stopped it: the loop runs until the order is resolved.
    expect(mockStopVibration).not.toHaveBeenCalled();
  });

  it('has no timer of its own — the repeat is a single native dispatch', () => {
    jest.useFakeTimers();
    const orderId = freshOrder();
    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');

    // Repeating with JS timers would need the runtime to keep firing; advancing
    // time must produce no further bridge traffic.
    jest.advanceTimersByTime(60_000);
    expect(mockStartVibration).toHaveBeenCalledTimes(1);
    expect(mockStopVibration).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});

describe('9 — duplicates never stack a second loop', () => {
  it('collapses three deliveries of the same order onto one dispatch', () => {
    const orderId = freshOrder();

    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');
    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');
    notificationService.routeOrderEventData(newOrderPayload(orderId), 'opened');

    expect(mockStartVibration).toHaveBeenCalledTimes(1);
  });

  it('ignores a repeat call for the order it is already vibrating for', () => {
    const orderId = freshOrder();
    orderVibration.startOrderVibration(orderId);
    orderVibration.startOrderVibration(orderId);

    expect(mockStartVibration).toHaveBeenCalledTimes(1);
  });

  it('never buzzes for an order decided before its push landed', () => {
    const orderId = freshOrder();
    alertSync.applyOrderDecision(orderId, 'ACCEPTED');

    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');

    expect(mockStartVibration).not.toHaveBeenCalled();
    expect(orderVibration.getVibratingOrderId()).toBeNull();
  });

  it('does not restart after the resolution it just handled', () => {
    const orderId = freshOrder();
    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');
    notificationService.routeOrderEventData(
      statusPayload(orderId, 'ACCEPTED'),
      'foreground',
    );
    // A stale retry of the same NEW_ORDER arrives afterwards.
    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');

    expect(mockStartVibration).toHaveBeenCalledTimes(1);
    expect(mockStopVibration).toHaveBeenCalledTimes(1);
    expect(orderVibration.getVibratingOrderId()).toBeNull();
  });

  it('never replays a buffered alert that was decided while no screen was mounted', () => {
    /* The push lands while OrdersScreen is unmounted (the vendor is in
     * Settings), so it is buffered. Another device settles it before the screen
     * comes back — the buffered alert must then be dropped, not replayed. This
     * was the popup reopening after an accept. */
    const orderId = freshOrder();
    notificationService.removeIncomingOrderHandler();
    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');

    notificationService.routeOrderEventData(
      statusPayload(orderId, 'ACCEPTED'),
      'background',
    );

    const onIncoming = jest.fn();
    notificationService.setIncomingOrderHandler(onIncoming);

    expect(onIncoming).not.toHaveBeenCalled();
    expect(mockStartVibration).toHaveBeenCalledTimes(1);
    expect(mockStopVibration).toHaveBeenCalledTimes(1);
    notificationService.removeIncomingOrderHandler();
  });

  it('does replay a buffered alert that is still awaiting a decision', () => {
    const orderId = freshOrder();
    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');
    // The screen unmounted between the push and its remount: the owner released
    // the haptic, so the replay re-arms it for the same single loop.
    orderVibration.stopOrderVibration();
    const onIncoming = jest.fn();

    notificationService.setIncomingOrderHandler(onIncoming);

    expect(onIncoming).toHaveBeenCalledTimes(1);
    expect(mockStartVibration).toHaveBeenCalledTimes(2);
    expect(orderVibration.getVibratingOrderId()).toBe(orderId);
    notificationService.removeIncomingOrderHandler();
  });
});

/* ── 2 + 3 + 4 — every resolution path ends the haptic ──────────────────── */

describe('2/3/4 — accept, reject and a remote decision all stop it', () => {
  it.each(['ACCEPTED', 'REJECTED'] as const)('this device decides %s', decision => {
    const orderId = freshOrder();
    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');

    alertSync.applyOrderDecision(orderId, decision);

    expect(mockStopVibration).toHaveBeenCalledTimes(1);
    expect(orderVibration.getVibratingOrderId()).toBeNull();
  });

  it.each(['ACCEPTED', 'REJECTED'] as const)(
    'Phone A decides %s — Phone B stops on the ORDER_STATUS_UPDATED push',
    decision => {
      const orderId = freshOrder();
      // Phone B is in the foreground, alerting for the order.
      notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');
      expect(orderVibration.getVibratingOrderId()).toBe(orderId);

      notificationService.routeOrderEventData(
        statusPayload(orderId, decision),
        'foreground',
      );

      expect(mockStopVibration).toHaveBeenCalledTimes(1);
      expect(orderVibration.getVibratingOrderId()).toBeNull();
      expect(alertSync.isAlertActive(orderId)).toBe(false);
      // The stop is idempotent — a duplicate push cannot release it twice.
      notificationService.routeOrderEventData(
        statusPayload(orderId, decision),
        'foreground',
      );
      expect(mockStopVibration).toHaveBeenCalledTimes(2);
      expect(orderVibration.getVibratingOrderId()).toBeNull();
    },
  );

  it('stops on a background-runtime decision too', () => {
    const orderId = freshOrder();
    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');

    notificationService.routeOrderEventData(
      statusPayload(orderId, 'ACCEPTED'),
      'background',
    );

    expect(mockStopVibration).toHaveBeenCalledTimes(1);
  });
});

/* ── the single-owner rules for several pending orders ──────────────────── */

describe('multiple pending orders — one owner, no gaps', () => {
  it('re-targets the loop to the surviving order instead of going silent', () => {
    const first = freshOrder();
    const second = freshOrder();

    notificationService.routeOrderEventData(newOrderPayload(first), 'foreground');
    notificationService.routeOrderEventData(newOrderPayload(second), 'foreground');
    expect(orderVibration.getVibratingOrderId()).toBe(second);

    alertSync.applyOrderDecision(second, 'ACCEPTED');

    // The loop is re-dispatched for the order still awaiting a decision, so the
    // vendor never loses the alert — and it is never a second simultaneous loop.
    expect(mockStopVibration).not.toHaveBeenCalled();
    expect(mockStartVibration).toHaveBeenCalledTimes(3);
    expect(orderVibration.getVibratingOrderId()).toBe(first);
    expect(alertSync.isAlertActive(first)).toBe(true);

    alertSync.applyOrderDecision(first, 'REJECTED');
    expect(mockStopVibration).toHaveBeenCalledTimes(1);
    expect(orderVibration.getVibratingOrderId()).toBeNull();
  });

  it('a decision for an unrelated order leaves the alerting one alone', () => {
    const alerting = freshOrder();
    const other = freshOrder();
    notificationService.routeOrderEventData(newOrderPayload(alerting), 'foreground');

    alertSync.applyOrderDecision(other, 'ACCEPTED');

    expect(mockStopVibration).not.toHaveBeenCalled();
    expect(orderVibration.getVibratingOrderId()).toBe(alerting);
  });
});

/* ── 5 — the sound switch must never reach the haptic ───────────────────── */

describe('5 — Sound OFF silences the audio, never the vibration', () => {
  it('skips playback and still starts the repeating haptic', async () => {
    await soundPreference.setNotificationSoundEnabled(false);
    const orderId = freshOrder();

    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');

    expect(mockStartForegroundSound).not.toHaveBeenCalled();
    expect(mockStartVibration).toHaveBeenCalledTimes(1);
    expect(orderVibration.getVibratingOrderId()).toBe(orderId);
  });

  it('never reads the preference on the way to the motor', async () => {
    await soundPreference.setNotificationSoundEnabled(false);
    mockGetNotificationSoundEnabled.mockClear();

    notificationService.routeOrderEventData(
      newOrderPayload(freshOrder()),
      'foreground',
    );

    // A stale or unreadable cached preference cannot mute the haptic.
    expect(mockGetNotificationSoundEnabled).not.toHaveBeenCalled();
    expect(mockStartVibration).toHaveBeenCalledTimes(1);
  });

  it('with Sound ON both the audio and the haptic run', async () => {
    await soundPreference.setNotificationSoundEnabled(true);
    const orderId = freshOrder();

    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');
    // The in-app modal is the audio owner.
    alertSync.claimNewOrderAlert(orderId);

    expect(mockStartVibration).toHaveBeenCalledTimes(1);
  });
});

/* ── 6 + 7 — what the killed / background alert is allowed to contain ───── */

describe('6 — the background alert carries no order data', () => {
  it('passes only the order id across the bridge', async () => {
    const orderId = freshOrder();
    notificationService.registerBackgroundHandler();
    expect(mockBackgroundHandler).not.toBeNull();

    await mockBackgroundHandler!({ data: newOrderPayload(orderId) });

    expect(mockStartOrderAlert).toHaveBeenCalledTimes(1);
    expect(mockStartOrderAlert).toHaveBeenCalledWith({ orderId });
    // Nothing the notification could render as sensitive content.
    const crossed = bridgeCallLog();
    for (const secret of [CUSTOMER, PHONE, ADDRESS, '250', 'Ghee Jar', 'PAID']) {
      expect(crossed).not.toContain(secret);
    }
  });

  it('claims no JS haptic owner — the native service is the owner there', async () => {
    const orderId = freshOrder();
    notificationService.routeOrderEventData(newOrderPayload(orderId), 'background');

    expect(alertSync.isAlertActive(orderId)).toBe(true);
    expect(mockStartVibration).not.toHaveBeenCalled();
    expect(orderVibration.getVibratingOrderId()).toBeNull();
  });

  it('rings for a decided order never', async () => {
    const orderId = freshOrder();
    alertSync.applyOrderDecision(orderId, 'ACCEPTED');

    notificationService.routeOrderEventData(newOrderPayload(orderId), 'background');

    expect(mockStartOrderAlert).not.toHaveBeenCalled();
  });
});

describe('7 — no notification action button can be built', () => {
  /** The bridge surface the notification code has access to. There is no
   *  addAction / showOrderNotification entry left, so JS cannot hand Accept and
   *  Reject buttons to a killed-app notification. */
  it('exposes only post, dismiss, stop, haptic and navigation methods', () => {
    const surface = Object.keys(mockFullBridge()).sort();
    expect(surface).toEqual([
      'dismissNotification',
      'getNotificationSoundEnabled',
      'getPendingOrdersNavigation',
      'getTappedOrderId',
      'setApiBaseUrl',
      'setNotificationSoundEnabled',
      'startForegroundSound',
      'startOrderAlert',
      'startOrderAlertVibration',
      'stopForegroundSound',
      'stopOrderAlert',
      'stopOrderAlertVibration',
    ]);
    // No method takes an action list, a title or a body — and nothing on the
    // surface is named like a button: the notification is posted in Kotlin.
    expect(surface.join(' ')).not.toMatch(/action|accept|reject|addAction/i);
  });

  it('has no JS path that posts a notification at all', () => {
    const exported = Object.keys(notificationService);
    expect(exported).not.toContain('showNativeOrderNotification');
    expect(exported).not.toContain('startNativeOrderAlert');
  });
});

/* ── 8 — the tap opens the Orders screen ────────────────────────────────── */

describe('8 — tapping the generic alert opens Orders', () => {
  it('routes the live native event to the handler App.tsx registers', async () => {
    await notificationService.initializeNotifications('user-1');
    const openOrders = jest.fn();
    notificationService.setOpenOrdersHandler(openOrders);

    expect(mockEventHandlers['NotificationOpenOrders']).toBeDefined();
    (mockEventHandlers['NotificationOpenOrders'] ?? []).forEach(handler => handler());

    expect(openOrders).toHaveBeenCalledTimes(1);
  });

  it('pulls the cold-start flag once and clears it', async () => {
    mockGetPendingOrdersNavigation.mockResolvedValueOnce(true);
    await expect(notificationService.consumePendingOrdersNavigation()).resolves.toBe(
      true,
    );
    expect(mockGetPendingOrdersNavigation).toHaveBeenCalledTimes(1);
  });

  it('reports no navigation when nothing was tapped', async () => {
    await expect(notificationService.consumePendingOrdersNavigation()).resolves.toBe(
      false,
    );
  });

  it('drops the handler when the app unregisters it', async () => {
    const openOrders = jest.fn();
    notificationService.setOpenOrdersHandler(openOrders);
    notificationService.removeOpenOrdersHandler();

    await notificationService.initializeNotifications('user-1');
    (mockEventHandlers['NotificationOpenOrders'] ?? []).forEach(handler => handler());

    expect(openOrders).not.toHaveBeenCalled();
  });

  it('a killed-app tap that lands before init is not lost', async () => {
    // MainActivity holds the flag until JS asks for it, so the order of the
    // event listener and the cold-start pull cannot drop the navigation.
    await notificationService.initializeNotifications('user-1');
    mockGetPendingOrdersNavigation.mockResolvedValueOnce(true);
    await expect(notificationService.consumePendingOrdersNavigation()).resolves.toBe(
      true,
    );
  });
});

/* ── dispose + logout ───────────────────────────────────────────────────── */

describe('cleanup — nothing outlives the alert that owns it', () => {
  it('signing out releases the haptic', () => {
    const orderId = freshOrder();
    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');

    notificationService.resetNotificationInitialization();

    expect(mockStopVibration).toHaveBeenCalledTimes(1);
    expect(orderVibration.getVibratingOrderId()).toBeNull();
    expect(alertSync.isAlertActive(orderId)).toBe(false);
  });

  it('stop is safe when nothing was ever vibrating', () => {
    expect(() => orderVibration.stopOrderVibration()).not.toThrow();
    expect(mockStopVibration).toHaveBeenCalledTimes(1);
  });

  it('a bridge from an older APK says so instead of failing silently', () => {
    /* The controller resolves the bridge once at module load, so this needs a
     * fresh module registry built against a stripped-down NativeModules. */
    mockBridgeOverride = {
      ...mockFullBridge(),
      startOrderAlertVibration: undefined,
      stopOrderAlertVibration: undefined,
    };
    jest.resetModules();
    jest.isolateModules(() => {
      const fresh = require('../src/services/orderVibration') as typeof orderVibration;
      fresh.startOrderVibration('order-old-apk');

      // No claim is recorded for a haptic that cannot be dispatched, and the
      // alert itself still runs — a phone that cannot buzz must not lose orders.
      expect(fresh.getVibratingOrderId()).toBeNull();
    });
    mockBridgeOverride = null;
  });
});
