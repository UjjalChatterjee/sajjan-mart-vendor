/**
 * Notification-panel ACCEPT / REJECT — the JS settlement half of the killed-app
 * field failure ("tapping ACCEPT from the shade did not accept the order").
 *
 *   npx jest __tests__/order-action-settlement.test.ts
 *
 * Backend contract (sajjan-mart, PUT /api/orders/[id]):
 *   200 → this device moved the order out of `pending`.
 *   409 → ORDER_ALREADY_PROCESSED: another device already decided it. Final, not
 *         a failure — the alert is stale, so it closes instead of retrying.
 *   401 / 403 / network / 5xx → the decision never landed. The alert must stay.
 *
 * The rule these tests pin is the one the old code broke in two places: it
 * dismissed the notification without calling the API when no screen owned the
 * tap, and it treated any tap as settled. A decision that failed to reach the
 * server must leave the order pending and the notification tappable.
 *
 * What JS cannot prove: the receiver waking a dead process, the SharedPreferences
 * base URL, the access-token read out of the AsyncStorage SQLite file, the
 * foreground-service submission and the notification action request codes. Those
 * are Kotlin and only a rebuilt APK on two phones can confirm them.
 */

/* ── Bridge stand-ins ────────────────────────────────────────────────────── */

var mockDismissNotification = jest.fn();
var mockStopOrderAlert = jest.fn();
var mockStartForegroundSound = jest.fn();
var mockStopForegroundSound = jest.fn();
var mockStartOrderAlertVibration = jest.fn();
var mockStopOrderAlertVibration = jest.fn();
var mockSetApiBaseUrl = jest.fn();
var mockAcceptOrder = jest.fn();
var mockRejectOrder = jest.fn();
var mockGetOrders = jest.fn(async () => [] as unknown[]);
var mockApiPost = jest.fn(async (..._args: unknown[]) => ({}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 29, select: (options: any) => options.android },
  NativeModules: {
    NotificationHelper: {
      getNotificationSoundEnabled: jest.fn(async () => true),
      setNotificationSoundEnabled: jest.fn(),
      startOrderAlertVibration: () => mockStartOrderAlertVibration(),
      stopOrderAlertVibration: () => mockStopOrderAlertVibration(),
      startForegroundSound: () => mockStartForegroundSound(),
      stopForegroundSound: () => mockStopForegroundSound(),
      startOrderAlert: jest.fn(),
      stopOrderAlert: () => mockStopOrderAlert(),
      dismissNotification: (orderId: string) => mockDismissNotification(orderId),
      setApiBaseUrl: (url: string) => mockSetApiBaseUrl(url),
      getTappedOrderId: jest.fn(async () => null),
      getPendingOrdersNavigation: jest.fn(async () => false),
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
  getToken: jest.fn(async () => 'mock-fcm-token'),
  onMessage: jest.fn(() => () => {}),
  onTokenRefresh: jest.fn(() => () => {}),
  onNotificationOpenedApp: jest.fn(() => () => {}),
  getInitialNotification: jest.fn(async () => null),
  setBackgroundMessageHandler: jest.fn(),
}));

jest.mock('../src/services/order.service', () => ({
  getOrders: () => mockGetOrders(),
  acceptOrder: (...args: unknown[]) => mockAcceptOrder(...args),
  rejectOrder: (...args: unknown[]) => mockRejectOrder(...args),
}));

jest.mock('../src/services/api.client', () => {
  // Mirrors the real export surface (ApiError + the four request helpers) so any
  // module that reaches for the client inside this graph gets a working stub.
  class MockApiError extends Error {
    status?: number;
    sessionInvalid = false;
  }
  const request = (path: string, body?: unknown) => mockApiPost(path, body);
  return {
    ApiError: MockApiError,
    onAuthExpired: jest.fn(() => () => {}),
    apiGet: (path: string) => request(path),
    apiPost: (path: string, body?: unknown) => request(path, body),
    apiPut: (path: string, body?: unknown) => request(path, body),
    apiPostWithResponse: (path: string, body?: unknown) => request(path, body),
  };
});

import { Env } from '../src/config/env';
import * as alertSync from '../src/services/orderAlertSync';
import { stopOrderAlertSound } from '../src/services/sound.service';
import * as notificationService from '../src/services/notification.service';

/* ── Fixtures ────────────────────────────────────────────────────────────── */

let uniqueOrder = 0;
/** The dedupe set and the alert registry are module state: a shared id across
 *  tests would let one test's claim swallow the next one's tap. */
function freshOrder(): string {
  uniqueOrder += 1;
  return `order-act-${uniqueOrder}`;
}

function httpError(status: number, message = 'request failed'): Error {
  return Object.assign(new Error(message), { status });
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

/** Raise the alert exactly as an incoming push does, so the notification and the
 *  registry exist before the tap is processed. */
function alertFor(orderId: string): void {
  notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');
}

const flush = (): Promise<void> =>
  new Promise(resolve => {
    setImmediate(() => resolve());
  });

beforeEach(() => {
  stopOrderAlertSound();
  jest.clearAllMocks();
  mockGetOrders.mockResolvedValue([]);
  mockApiPost.mockResolvedValue({});
  mockAcceptOrder.mockResolvedValue({ ok: true });
  mockRejectOrder.mockResolvedValue({ ok: true });
  notificationService.setIncomingOrderHandler(jest.fn());
  notificationService.removeIncomingOrderHandler();
  notificationService.setNotificationActionHandler(jest.fn());
  notificationService.removeNotificationActionHandler();
  notificationService.resetNotificationInitialization();
  alertSync.resetOrderAlertState();
});

/* ── 1 — a confirmed decision settles everything ─────────────────────────── */

describe('1 — the backend confirming a tap closes the alert', () => {
  it('ACCEPT writes once, records the order as decided and cancels its notification', async () => {
    const orderId = freshOrder();
    alertFor(orderId);

    const settled = await notificationService.settleNotificationAction(
      'ORDER_ACCEPT',
      orderId,
    );

    expect(settled).toBe(true);
    expect(mockAcceptOrder).toHaveBeenCalledTimes(1);
    expect(mockAcceptOrder).toHaveBeenCalledWith(orderId);
    expect(mockRejectOrder).not.toHaveBeenCalled();
    expect(alertSync.decidedStatusFor(orderId)).toBe('confirmed');
    expect(alertSync.isAlertActive(orderId)).toBe(false);
    expect(mockDismissNotification).toHaveBeenCalledWith(orderId);
  });

  it('REJECT writes to the reject path and records cancelled', async () => {
    const orderId = freshOrder();
    alertFor(orderId);

    const settled = await notificationService.settleNotificationAction(
      'ORDER_REJECT',
      orderId,
    );

    expect(settled).toBe(true);
    expect(mockRejectOrder).toHaveBeenCalledWith(orderId);
    expect(alertSync.decidedStatusFor(orderId)).toBe('cancelled');
  });
});

/* ── 2 — 409 is a settled order, not a failure ───────────────────────────── */

describe('2 — a 409 is reconciled instead of retried', () => {
  it('treats ORDER_ALREADY_PROCESSED as final and closes the stale alert', async () => {
    const orderId = freshOrder();
    alertFor(orderId);
    mockAcceptOrder.mockRejectedValue(httpError(409, 'ORDER_ALREADY_PROCESSED'));
    mockGetOrders.mockResolvedValue([{ id: orderId, status: 'confirmed' }]);

    const settled = await notificationService.settleNotificationAction(
      'ORDER_ACCEPT',
      orderId,
    );

    expect(settled).toBe(true);
    // Exactly one attempt: a 409 must never turn into a retry loop.
    expect(mockAcceptOrder).toHaveBeenCalledTimes(1);
    expect(alertSync.isAlertActive(orderId)).toBe(false);
    expect(alertSync.decidedStatusFor(orderId)).toBe('confirmed');
    expect(mockDismissNotification).toHaveBeenCalledWith(orderId);
  });

  it('closes the alert even when the follow-up status read fails', async () => {
    const orderId = freshOrder();
    alertFor(orderId);
    mockAcceptOrder.mockRejectedValue(httpError(409, 'ORDER_ALREADY_PROCESSED'));
    mockGetOrders.mockRejectedValue(new Error('offline'));

    await expect(
      notificationService.settleNotificationAction('ORDER_ACCEPT', orderId),
    ).resolves.toBe(true);

    // The 409 itself proves the order left `pending`, so the alert is stale.
    expect(alertSync.isAlertActive(orderId)).toBe(false);
  });
});

/* ── 3 — a failed decision stays recoverable ─────────────────────────────── */

describe('3 — nothing is hidden when the backend never confirmed', () => {
  it.each([
    ['network failure', undefined],
    ['expired session', 401],
    ['forbidden', 403],
    ['server error', 500],
  ])('%s → the alert survives as the retry point', async (_name, status) => {
    const orderId = freshOrder();
    alertFor(orderId);
    mockAcceptOrder.mockRejectedValue(
      status === undefined ? new Error('No connection') : httpError(status as number),
    );

    const settled = await notificationService.settleNotificationAction(
      'ORDER_ACCEPT',
      orderId,
    );

    expect(settled).toBe(false);
    expect(alertSync.isAlertActive(orderId)).toBe(true);
    expect(alertSync.decidedStatusFor(orderId)).toBeNull();
    // The whole bug being fixed: the tap used to cancel the notification here.
    expect(mockDismissNotification).not.toHaveBeenCalled();
  });

  it('reports the failure without a second write', async () => {
    const orderId = freshOrder();
    alertFor(orderId);
    mockAcceptOrder.mockRejectedValue(new Error('No connection'));

    await notificationService.settleNotificationAction('ORDER_ACCEPT', orderId);

    // One tap = one attempt. Retrying is the admin tapping again, from a path
    // that still shows the buttons.
    expect(mockAcceptOrder).toHaveBeenCalledTimes(1);
  });
});

/* ── 4 + 5 — processAction owns the tap when no screen does ──────────────── */

describe('4 — with no screen mounted, the tap still reaches the server', () => {
  it('submits the decision instead of only hiding the notification', async () => {
    const orderId = freshOrder();
    alertFor(orderId);
    notificationService.removeNotificationActionHandler();

    notificationService.processAction('ORDER_ACCEPT', orderId);

    // The tap itself settles nothing: the alert is only closed by the server's
    // answer (test 3), never by the tap.
    expect(mockDismissNotification).not.toHaveBeenCalled();
    expect(alertSync.isAlertActive(orderId)).toBe(true);

    await flush();

    expect(mockAcceptOrder).toHaveBeenCalledWith(orderId);
    expect(alertSync.isAlertActive(orderId)).toBe(false);
    expect(mockDismissNotification).toHaveBeenCalledWith(orderId);
  });

  it('releases the duplicate claim after a failed send so the admin can tap again', async () => {
    const orderId = freshOrder();
    alertFor(orderId);
    notificationService.removeNotificationActionHandler();
    mockAcceptOrder.mockRejectedValue(new Error('No connection'));

    notificationService.processAction('ORDER_ACCEPT', orderId);
    await flush();
    expect(mockAcceptOrder).toHaveBeenCalledTimes(1);

    // Second tap: the order is still pending and still on screen, so it submits.
    notificationService.processAction('ORDER_ACCEPT', orderId);
    await flush();
    expect(mockAcceptOrder).toHaveBeenCalledTimes(2);
  });

  it('ignores the second tap once the server has settled the order', async () => {
    const orderId = freshOrder();
    alertFor(orderId);
    notificationService.removeNotificationActionHandler();

    notificationService.processAction('ORDER_ACCEPT', orderId);
    await flush();
    notificationService.processAction('ORDER_ACCEPT', orderId);
    await flush();

    // Exactly one backend write per order, whichever way the tap lands.
    expect(mockAcceptOrder).toHaveBeenCalledTimes(1);
  });
});

describe('5 — a mounted screen keeps ownership of the tap', () => {
  it('hands the action over without a parallel submit', () => {
    const orderId = freshOrder();
    const onAction = jest.fn();
    notificationService.setNotificationActionHandler(onAction);

    notificationService.processAction('ORDER_REJECT', orderId);

    expect(onAction).toHaveBeenCalledWith({ action: 'ORDER_REJECT', orderId });
    expect(mockRejectOrder).not.toHaveBeenCalled();
  });
});

/* ── 6 — the headless task uses the same settlement ──────────────────────── */

describe('6 — the headless task cannot drift from the tap path', () => {
  it('settles through settleNotificationAction', async () => {
    const orderId = freshOrder();
    let task:
      | ((data: { data: { action: string; orderId: string } }) => Promise<void>)
      | null = null;
    jest
      .requireMock('react-native')
      .AppRegistry.registerHeadlessTask.mockImplementation(
        (_name: string, factory: () => typeof task) => {
          task = factory();
        },
      );

    notificationService.registerHeadlessTask();
    expect(task).not.toBeNull();

    await task!({ data: { action: 'ORDER_ACCEPT', orderId } });

    expect(mockAcceptOrder).toHaveBeenCalledWith(orderId);
  });
});

/* ── 7 — native code is told which server to call ────────────────────────── */

describe('7 — the killed-app path is given a real server address', () => {
  it('publishes the JS environment URL into the native store at start-up', async () => {
    await notificationService.initializeNotifications('user-1');

    // Kotlin keeps no URL of its own; without this the background tap had only
    // loopback candidates and every decision failed with "No connection".
    expect(mockSetApiBaseUrl).toHaveBeenCalledWith(Env.API_BASE_URL);
    expect(/^https?:\/\//.test(Env.API_BASE_URL)).toBe(true);
  });

  it('publishes it even when the bridge refuses', () => {
    mockSetApiBaseUrl.mockImplementation(() => {
      throw new Error('bridge busy');
    });

    expect(() => {
      const { syncApiBaseUrlToNative } = require('../src/config/apiBaseUrl');
      expect(syncApiBaseUrlToNative()).toBe(false);
    }).not.toThrow();
  });
});
