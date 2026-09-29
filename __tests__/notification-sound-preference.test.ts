/**
 * Notification-sound preference + always-on vibration — verification suite.
 *
 *   npx jest __tests__/notification-sound-preference.test.ts
 *
 * The preference lives in Android SharedPreferences (mirrored here by
 * mockSoundStore, which the mocked bridge reads and writes exactly like
 * NotificationHelperModule does). That single-store rule is what the suite
 * checks: JS never keeps its own copy as truth, and the value a killed app
 * reads is the value the Settings screen wrote.
 *
 * Covered:
 *   1. Default ON when nothing is stored.
 *   2. OFF → audio skipped, vibration still fires.
 *   3. ON  → audio and vibration both fire.
 *   4. The value survives a runtime restart (cache wiped, store re-read).
 *   5. Background push with OFF → the native alert still runs (notification +
 *      channel vibration) and no JS audio is started.
 *   6. The write reaches the native store, which is what the killed-app alert
 *      path reads.
 *   7. No duplicate vibration — one buzz per claimed alert, none for repeats,
 *      status events or background pushes.
 *   8. Multi-device cleanup still works while muted.
 *
 * What JS cannot prove: MediaPlayer actually going quiet, the vibrator motor,
 * the notification channel and the killed-app receiver. Those need the rebuilt
 * APK on a device.
 */

/* ── Native store stand-in: the one persisted source of truth ────────────── */

const mockSoundStore = { enabled: true };

const mockGetNotificationSoundEnabled = jest.fn(async () => mockSoundStore.enabled);
const mockSetNotificationSoundEnabled = jest.fn((enabled: boolean) => {
  mockSoundStore.enabled = enabled;
});
const mockVibrateOrderAlert = jest.fn();
const mockStartForegroundSound = jest.fn();
const mockStopForegroundSound = jest.fn();
const mockStartOrderAlert = jest.fn();
const mockStopOrderAlert = jest.fn();
const mockDismissNotification = jest.fn();

jest.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 34, select: (options: any) => options.android },
  NativeModules: {
    NotificationHelper: {
      getNotificationSoundEnabled: () => mockGetNotificationSoundEnabled(),
      setNotificationSoundEnabled: (enabled: boolean) =>
        mockSetNotificationSoundEnabled(enabled),
      vibrateOrderAlert: () => mockVibrateOrderAlert(),
      startForegroundSound: () => mockStartForegroundSound(),
      stopForegroundSound: () => mockStopForegroundSound(),
      startOrderAlert: (...args: unknown[]) => mockStartOrderAlert(...args),
      stopOrderAlert: (...args: unknown[]) => mockStopOrderAlert(...args),
      dismissNotification: (...args: unknown[]) => mockDismissNotification(...args),
      getTappedOrderId: jest.fn(async () => null),
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

const mockAsyncSetItem = jest.fn((..._args: unknown[]) => Promise.resolve());

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: (...args: unknown[]) => mockAsyncSetItem(...args),
    getItem: jest.fn(async () => null),
    removeItem: jest.fn(async () => {}),
  },
}));

/* notification.service pulls in Firebase, which ships as ESM Jest cannot parse
 * under the React Native preset. The background handler is captured instead of
 * registered for real. */
let mockBackgroundHandler:
  | ((message: { data: Record<string, string> }) => Promise<void>)
  | null = null;

jest.mock('@react-native-firebase/messaging', () => ({
  getMessaging: () => ({}),
  getToken: jest.fn(),
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

import * as soundPreference from '../src/config/notificationSound';
import {
  startOrderAlertSound,
  stopOrderAlertSound,
} from '../src/services/sound.service';
import * as alertSync from '../src/services/orderAlertSync';
import * as notificationService from '../src/services/notification.service';

/* ── Fixtures ───────────────────────────────────────────────────────────── */

const ORDER_A = 'order-aaa';
const ORDER_B = 'order-bbb';

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

/** The modal's behaviour: once the alert is claimed, ask for sound. */
function raiseForegroundAlert(orderId: string): void {
  notificationService.routeOrderEventData(newOrderPayload(orderId), 'foreground');
  startOrderAlertSound({ orderId, customerName: 'Customer', itemCount: '2', total: '250' });
}

/* ── Setup / teardown ───────────────────────────────────────────────────── */

beforeEach(() => {
  // sound.service holds the order it is ringing for in module state; cleared
  // first so one test's alert cannot dedupe the next test's one away.
  stopOrderAlertSound();
  jest.clearAllMocks();
  mockSoundStore.enabled = true;
  mockBackgroundHandler = null;
  // A foreground push with no screen mounted is buffered and flushed to the
  // next handler — drain it so a previous test's buffer cannot double-deliver.
  notificationService.setIncomingOrderHandler(jest.fn());
  notificationService.removeIncomingOrderHandler();
  // A fresh JS runtime: cache back to the default, store untouched.
  soundPreference.resetNotificationSoundPreferenceForTests();
  alertSync.resetOrderAlertState();
});

describe('1 — default is ON', () => {
  it('reports ON before anything has ever been stored', async () => {
    expect(soundPreference.isNotificationSoundEnabled()).toBe(true);
    await expect(soundPreference.loadNotificationSoundPreference()).resolves.toBe(true);
    expect(mockGetNotificationSoundEnabled).toHaveBeenCalledTimes(1);
  });

  it('keeps the last known value when the native read fails', async () => {
    await soundPreference.setNotificationSoundEnabled(false);
    mockGetNotificationSoundEnabled.mockRejectedValueOnce(new Error('bridge down'));

    soundPreference.resetNotificationSoundPreferenceForTests();
    await expect(soundPreference.loadNotificationSoundPreference()).resolves.toBe(true);

    // A broken bridge must not silently mute the vendor's orders.
    raiseForegroundAlert(ORDER_A);
    expect(mockStartForegroundSound).toHaveBeenCalledTimes(1);
  });
});

describe('2 — OFF disables sound, never vibration', () => {
  it('writes the switch through to the native store', async () => {
    await soundPreference.setNotificationSoundEnabled(false);

    expect(mockSetNotificationSoundEnabled).toHaveBeenCalledWith(false);
    expect(mockSoundStore.enabled).toBe(false);
    expect(soundPreference.isNotificationSoundEnabled()).toBe(false);
  });

  it('skips audio but still vibrates the new-order alert', async () => {
    await soundPreference.setNotificationSoundEnabled(false);

    raiseForegroundAlert(ORDER_A);

    expect(mockStartForegroundSound).not.toHaveBeenCalled();
    expect(mockVibrateOrderAlert).toHaveBeenCalledTimes(1);
  });

  it('records the alert so the modal and cleanup still see it', async () => {
    await soundPreference.setNotificationSoundEnabled(false);
    const onIncoming = jest.fn();
    notificationService.setIncomingOrderHandler(onIncoming);

    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'foreground');

    expect(alertSync.isAlertActive(ORDER_A)).toBe(true);
    expect(onIncoming).toHaveBeenCalledTimes(1);

    notificationService.removeIncomingOrderHandler();
  });
});

describe('3 — ON enables sound and vibration', () => {
  it('plays the siren and vibrates', async () => {
    await soundPreference.setNotificationSoundEnabled(true);

    raiseForegroundAlert(ORDER_A);

    expect(mockStartForegroundSound).toHaveBeenCalledTimes(1);
    expect(mockVibrateOrderAlert).toHaveBeenCalledTimes(1);
  });

  it('re-enabling after OFF restores audio', async () => {
    await soundPreference.setNotificationSoundEnabled(false);
    startOrderAlertSound({ orderId: ORDER_A });
    expect(mockStartForegroundSound).not.toHaveBeenCalled();

    await soundPreference.setNotificationSoundEnabled(true);
    alertSync.resetOrderAlertState();
    raiseForegroundAlert(ORDER_B);
    expect(mockStartForegroundSound).toHaveBeenCalledTimes(1);
  });
});

describe('4 — the preference persists', () => {
  it('survives a runtime restart: the cache is wiped, the store is read back', async () => {
    await soundPreference.setNotificationSoundEnabled(false);

    // Simulate force close + relaunch: a brand new JS runtime.
    soundPreference.resetNotificationSoundPreferenceForTests();
    expect(soundPreference.isNotificationSoundEnabled()).toBe(true);

    await expect(soundPreference.loadNotificationSoundPreference()).resolves.toBe(false);
    expect(soundPreference.isNotificationSoundEnabled()).toBe(false);

    raiseForegroundAlert(ORDER_A);
    expect(mockStartForegroundSound).not.toHaveBeenCalled();
    expect(mockVibrateOrderAlert).toHaveBeenCalledTimes(1);
  });

  it('is stored in exactly one place — nothing written to AsyncStorage', async () => {
    await soundPreference.setNotificationSoundEnabled(false);
    await soundPreference.loadNotificationSoundPreference();

    expect(mockAsyncSetItem).not.toHaveBeenCalled();
    expect(mockSetNotificationSoundEnabled).toHaveBeenCalledWith(false);
  });
});

describe('5 — background alert respects Sound OFF', () => {
  it('still starts the native alert (notification + channel vibration) and adds no JS audio or buzz', async () => {
    await soundPreference.setNotificationSoundEnabled(false);
    notificationService.registerBackgroundHandler();
    expect(mockBackgroundHandler).not.toBeNull();

    await mockBackgroundHandler!({ data: newOrderPayload(ORDER_A) });

    // The service posts the order notification, which vibrates on the channel —
    // muting the sound must not take that away.
    expect(mockStartOrderAlert).toHaveBeenCalledTimes(1);
    // JS playback is never started here, so the mute cannot be bypassed...
    expect(mockStartForegroundSound).not.toHaveBeenCalled();
    // ...and the JS haptic is skipped, because the notification already buzzes.
    expect(mockVibrateOrderAlert).not.toHaveBeenCalled();
  });

  it('never rings an order another device already decided', async () => {
    alertSync.applyOrderDecision(ORDER_A, 'ACCEPTED');
    notificationService.registerBackgroundHandler();

    await mockBackgroundHandler!({ data: newOrderPayload(ORDER_A) });

    expect(mockStartOrderAlert).not.toHaveBeenCalled();
    expect(mockVibrateOrderAlert).not.toHaveBeenCalled();
  });
});

describe('6 — the killed-app path reads the same value', () => {
  it('persists OFF into the native store that OrderAlertService reads', async () => {
    await soundPreference.setNotificationSoundEnabled(false);

    // No JS runtime is alive when a killed-app push is handled: the decision is
    // made in Kotlin from this file (NotificationHelperModule
    // .isNotificationSoundEnabled), not from anything JS still remembers.
    expect(mockSoundStore.enabled).toBe(false);
    expect(mockSetNotificationSoundEnabled).toHaveBeenCalledWith(false);

    soundPreference.resetNotificationSoundPreferenceForTests();
    expect(mockSoundStore.enabled).toBe(false);
  });

  it('never re-publishes a JS-side default over the stored value at start-up', async () => {
    mockSoundStore.enabled = false;
    soundPreference.resetNotificationSoundPreferenceForTests();

    await soundPreference.loadNotificationSoundPreference();

    // index.js only reads now — the old startup wrote a hardcoded constant over
    // the user's choice on every runtime start.
    expect(mockSetNotificationSoundEnabled).not.toHaveBeenCalled();
    expect(soundPreference.isNotificationSoundEnabled()).toBe(false);
  });
});

describe('7 — one vibration per alert', () => {
  it('ignores an FCM redelivery of the same order', () => {
    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'foreground');
    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'foreground');
    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'foreground');

    expect(mockVibrateOrderAlert).toHaveBeenCalledTimes(1);
  });

  it('vibrates once per distinct order', () => {
    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'foreground');
    notificationService.routeOrderEventData(newOrderPayload(ORDER_B), 'foreground');

    expect(mockVibrateOrderAlert).toHaveBeenCalledTimes(2);
  });

  it('does not buzz for a status event or a tapped notification re-open', () => {
    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'foreground');
    expect(mockVibrateOrderAlert).toHaveBeenCalledTimes(1);

    notificationService.routeOrderEventData(statusPayload(ORDER_A, 'ACCEPTED'), 'foreground');
    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'background');
    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'opened');

    expect(mockVibrateOrderAlert).toHaveBeenCalledTimes(1);
  });

  it('stays silent for an order that was already decided before its push landed', () => {
    alertSync.applyOrderDecision(ORDER_A, 'REJECTED');

    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'foreground');

    expect(mockVibrateOrderAlert).not.toHaveBeenCalled();
    expect(mockStartForegroundSound).not.toHaveBeenCalled();
  });
});

describe('8 — multi-device cleanup still runs while muted', () => {
  it('stops the alert and cancels the order notification on ORDER_STATUS_UPDATED', async () => {
    await soundPreference.setNotificationSoundEnabled(false);
    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'foreground');

    notificationService.routeOrderEventData(statusPayload(ORDER_A, 'ACCEPTED'), 'foreground');

    expect(alertSync.isAlertActive(ORDER_A)).toBe(false);
    expect(mockDismissNotification).toHaveBeenCalledWith(ORDER_A);
    // Nothing was ringing, so JS only issues the unconditional audio release.
    // Stopping the native service is the receiver's job there — it owns what it
    // started, and JS must not tear down an alert it never raised.
    expect(mockStopForegroundSound).toHaveBeenCalled();
    expect(mockStopOrderAlert).not.toHaveBeenCalled();
  });

  it('also stops the native service when JS owns the siren', async () => {
    await soundPreference.setNotificationSoundEnabled(true);
    raiseForegroundAlert(ORDER_A);

    notificationService.routeOrderEventData(statusPayload(ORDER_A, 'ACCEPTED'), 'foreground');

    expect(mockStopOrderAlert).toHaveBeenCalledTimes(1);
    expect(mockDismissNotification).toHaveBeenCalledWith(ORDER_A);
  });

  it('leaves another order alert alone', async () => {
    await soundPreference.setNotificationSoundEnabled(false);
    notificationService.routeOrderEventData(newOrderPayload(ORDER_A), 'foreground');
    notificationService.routeOrderEventData(newOrderPayload(ORDER_B), 'foreground');

    notificationService.routeOrderEventData(statusPayload(ORDER_A, 'REJECTED'), 'foreground');

    expect(alertSync.isAlertActive(ORDER_B)).toBe(true);
    expect(mockDismissNotification).toHaveBeenCalledTimes(1);
    expect(mockDismissNotification).toHaveBeenCalledWith(ORDER_A);
    // B is undecided, so the shared siren must not be silenced by A's decision.
    expect(mockStopOrderAlert).not.toHaveBeenCalled();
  });
});
