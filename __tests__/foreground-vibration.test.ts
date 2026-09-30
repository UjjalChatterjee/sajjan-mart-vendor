/**
 * Foreground new-order haptic — bridge dispatch regression suite.
 *
 *   npx jest __tests__/foreground-vibration.test.ts
 *
 * This file used to pin the one-shot `vibrateOrderAlert` bridge call. That
 * method is gone: the repeating loop now lives in
 * android/…/OrderVibration.kt and JS drives it through
 * src/services/orderVibration.ts, so the loop contract (start on claim, stop on
 * any decision, one owner, no stacked loops) is verified in
 * __tests__/continuous-order-vibration.test.ts.
 *
 * What stays here is the field-diagnostic half — the failure this suite was
 * written for was "the popup appeared on both phones, neither one buzzed", and
 * the only way to tell "JS never asked" apart from "the OS dropped it" is what
 * the JS layer logs on the way out:
 *
 *   1. A claimed foreground NEW_ORDER dispatches exactly one bridge call, and
 *      logs the dispatch under [ORDER-VIBE].
 *   2. A delivery retry of the same order dispatches nothing extra.
 *   3. Status events, background pushes and notification re-opens stay silent
 *      on the JS side — the native service owns the haptic there.
 *   4. Sound OFF still vibrates, and the haptic never reads the switch.
 *   5. An order another device already decided never buzzes.
 *   6. A bridge without the method (an APK older than this build) and a bridge
 *      that throws are both reported and must never break the alert.
 *
 * What JS cannot prove: that the motor actually ran. The Kotlin half logs the
 * device state (SDK, ringer mode, DND filter, channel config) under the same
 * tag, and the USAGE_ALARM dispatch is only verifiable on a device.
 */

/* ── Bridge stand-ins ────────────────────────────────────────────────────── */

/** When set, the next `require` of react-native builds NativeModules from this
 *  object instead of the full bridge — used by the "old installed APK" tests. */
var mockBridgeOverride: Record<string, unknown> | null = null;

var mockStartOrderAlertVibration = jest.fn();
var mockStopOrderAlertVibration = jest.fn();
var mockStartForegroundSound = jest.fn();
var mockStopForegroundSound = jest.fn();
var mockStartOrderAlert = jest.fn();
var mockStopOrderAlert = jest.fn();
var mockDismissNotification = jest.fn();
var mockGetNotificationSoundEnabled = jest.fn(async () => true);
var mockSetNotificationSoundEnabled = jest.fn();

function mockFullBridge(): Record<string, unknown> {
  return {
    getNotificationSoundEnabled: () => mockGetNotificationSoundEnabled(),
    setNotificationSoundEnabled: (enabled: boolean) =>
      mockSetNotificationSoundEnabled(enabled),
    startOrderAlertVibration: () => mockStartOrderAlertVibration(),
    stopOrderAlertVibration: () => mockStopOrderAlertVibration(),
    startForegroundSound: () => mockStartForegroundSound(),
    stopForegroundSound: () => mockStopForegroundSound(),
    startOrderAlert: (...args: unknown[]) => mockStartOrderAlert(...args),
    stopOrderAlert: (...args: unknown[]) => mockStopOrderAlert(...args),
    dismissNotification: (...args: unknown[]) => mockDismissNotification(...args),
    setApiBaseUrl: jest.fn(),
    getTappedOrderId: jest.fn(async () => null),
    getPendingOrdersNavigation: jest.fn(async () => false),
  };
}

/* Hoisted, so the jest.mock factory below can call it while the test file body
 * is still being evaluated (const/let would be in their temporal dead zone). */
function mockReactNative(): Record<string, unknown> {
  return {
    Platform: {
      OS: 'android',
      Version: 29,
      select: (options: any) => options.android,
    },
    NativeModules: {
      get NotificationHelper() {
        return mockBridgeOverride ?? mockFullBridge();
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
  };
}

jest.mock('react-native', () => mockReactNative());

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
  getToken: jest.fn(),
  onMessage: jest.fn(() => () => {}),
  onTokenRefresh: jest.fn(() => () => {}),
  onNotificationOpenedApp: jest.fn(() => () => {}),
  getInitialNotification: jest.fn(async () => null),
  setBackgroundMessageHandler: jest.fn(),
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

function statusPayload(orderId: string): Record<string, string> {
  return {
    type: 'ORDER_STATUS_UPDATED',
    eventType: 'ORDER_STATUS_UPDATED',
    eventId: `ORDER_STATUS_UPDATED:${orderId}`,
    orderId,
    status: 'ACCEPTED',
    decision: 'ACCEPTED',
  };
}

let orderSeq = 0;
/** Every test works on its own order: the alert registry is module state, and a
 *  shared id would let one test's claim swallow the next test's buzz. */
function freshOrder(): string {
  orderSeq += 1;
  return `order-vibe-${orderSeq}`;
}

let logs: string[];
let logSpy: jest.SpyInstance;

beforeEach(() => {
  stopOrderAlertSound();
  alertSync.resetOrderAlertState();
  jest.clearAllMocks();
  mockBridgeOverride = null;
  mockGetNotificationSoundEnabled.mockResolvedValue(true);
  logs = [];
  logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  notificationService.setIncomingOrderHandler(jest.fn());
  notificationService.removeIncomingOrderHandler();
  soundPreference.resetNotificationSoundPreferenceForTests();
});

afterEach(() => {
  logSpy.mockRestore();
  mockBridgeOverride = null;
  notificationService.removeIncomingOrderHandler();
});

const vibeLines = () => logs.filter(line => line.includes('[ORDER-VIBE]'));

/* ── 1 + 6 — the dispatch and its log line ───────────────────────────────── */

describe('1 — a foreground alert dispatches exactly one haptic loop', () => {
  it('calls the bridge once and logs the dispatch', () => {
    const orderId = freshOrder();

    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');

    expect(mockStartOrderAlertVibration).toHaveBeenCalledTimes(1);
    expect(vibeLines().join('\n')).toContain(orderId);
    // The controller must own the order, or cleanup cannot target it.
    expect(orderVibration.getVibratingOrderId()).toBe(orderId);
  });

  it('re-dispatches for a second, distinct order', () => {
    notificationService.routeOrderEventData(newOrderPayload(freshOrder()), 'foreground');
    notificationService.routeOrderEventData(newOrderPayload(freshOrder()), 'foreground');

    expect(mockStartOrderAlertVibration).toHaveBeenCalledTimes(2);
  });
});

describe('2 — a delivery retry adds no second loop', () => {
  it('collapses repeats of the same order onto the first claim', () => {
    const orderId = freshOrder();

    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');
    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');
    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');

    expect(mockStartOrderAlertVibration).toHaveBeenCalledTimes(1);
  });
});

describe('3 — everything that is not a claimed foreground alert stays silent', () => {
  it('ignores status events, background pushes and notification re-opens', () => {
    const orderId = freshOrder();
    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');
    expect(mockStartOrderAlertVibration).toHaveBeenCalledTimes(1);

    notificationService.routeOrderEventData(statusPayload(orderId), 'foreground');
    notificationService.routeOrderEventData(newOrderPayload(freshOrder()), 'background');
    notificationService.routeOrderEventData(newOrderPayload(freshOrder()), 'opened');

    expect(mockStartOrderAlertVibration).toHaveBeenCalledTimes(1);
  });

  it('ignores an order already decided before its push landed', () => {
    const orderId = freshOrder();
    alertSync.applyOrderDecision(orderId, 'ACCEPTED');

    notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');

    expect(mockStartOrderAlertVibration).not.toHaveBeenCalled();
    expect(vibeLines().join('\n')).not.toContain('Repeating haptic started');
  });
});

/* ── 4 — the sound switch must never reach this path ─────────────────────── */

describe('4 — Sound OFF still vibrates', () => {
  it('buzzes with the preference off', async () => {
    await soundPreference.setNotificationSoundEnabled(false);

    notificationService.routeOrderEventData(newOrderPayload(freshOrder()), 'foreground');

    expect(mockStartForegroundSound).not.toHaveBeenCalled();
    expect(mockStartOrderAlertVibration).toHaveBeenCalledTimes(1);
  });

  it('never reads the preference while vibrating', async () => {
    await soundPreference.setNotificationSoundEnabled(false);
    mockGetNotificationSoundEnabled.mockClear();

    notificationService.routeOrderEventData(
      newOrderPayload(freshOrder()),
      'foreground',
    );

    // The cached value is what gates audio; the haptic asks for nothing, so a
    // stale or unreadable preference cannot mute the motor.
    expect(mockGetNotificationSoundEnabled).not.toHaveBeenCalled();
    expect(mockStartOrderAlertVibration).toHaveBeenCalledTimes(1);
  });
});

/* ── 7 — a broken bridge is reported, not swallowed ──────────────────────── */

describe('7 — an unusable bridge still raises the alert and says why', () => {
  /** Re-require the services against a hand-built NativeModules bridge. Everything
   *  runs inside the isolated registry: resetModules gives that require its own
   *  copy of the module state, so the outer import cannot see these claims. */
  function runWithBridge(
    helper: Record<string, unknown>,
    body: (
      fresh: typeof notificationService,
      freshAlertSync: typeof alertSync,
      freshVibration: typeof orderVibration,
    ) => void,
  ): void {
    mockBridgeOverride = helper;
    jest.resetModules();
    jest.isolateModules(() => {
      const fresh = require('../src/services/notification.service') as typeof notificationService;
      const freshAlertSync = require('../src/services/orderAlertSync') as typeof alertSync;
      const freshVibration = require('../src/services/orderVibration') as typeof orderVibration;
      body(fresh, freshAlertSync, freshVibration);
      fresh.removeIncomingOrderHandler();
    });
    mockBridgeOverride = null;
  }

  it('a bridge without startOrderAlertVibration (APK older than this build) logs the reinstall hint', () => {
    const orderId = freshOrder();
    runWithBridge(
      { ...mockFullBridge(), startOrderAlertVibration: undefined },
      (fresh, sync, vibration) => {
        const onIncoming = jest.fn();
        fresh.setIncomingOrderHandler(onIncoming);

        fresh.routeOrderEventData(newOrderPayload(orderId), 'foreground');

        expect(mockStartOrderAlertVibration).not.toHaveBeenCalled();
        expect(vibeLines().join('\n')).toContain('reinstall the new APK');
        // Nothing is claimed as vibrating that no motor will ever honour.
        expect(vibration.getVibratingOrderId()).toBeNull();
        // The order is still claimed and still reaches the screen — a silent
        // phone must never turn into a lost order.
        expect(sync.isAlertActive(orderId)).toBe(true);
        expect(onIncoming).toHaveBeenCalledTimes(1);
      },
    );
  });

  it('a throwing bridge is caught and logged', () => {
    const orderId = freshOrder();
    runWithBridge(
      {
        ...mockFullBridge(),
        startOrderAlertVibration: () => {
          throw new Error('bridge is busy');
        },
      },
      (fresh, sync, vibration) => {
        fresh.setIncomingOrderHandler(jest.fn());

        expect(() =>
          fresh.routeOrderEventData(newOrderPayload(orderId), 'foreground'),
        ).not.toThrow();
        expect(vibeLines().join('\n')).toContain('bridge call threw');
        expect(sync.isAlertActive(orderId)).toBe(true);
        expect(vibration.getVibratingOrderId()).toBe(orderId);
      },
    );
  });
});
