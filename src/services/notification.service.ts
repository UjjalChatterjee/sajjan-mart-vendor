/**
 * Notification Service
 *
 * Centralised interface for Firebase Cloud Messaging (FCM) and
 * Android notification actions (ACCEPT / REJECT).
 *
 * Architecture:
 *   FCM Push  →  notification.service  →  Order Event  →  Order Store  →  UI
 *
 * App State Handling:
 *   FOREGROUND  →  onMessage() fires → JS shows modal + starts sound
 *   BACKGROUND  →  CustomMessagingReceiver starts native OrderAlertService directly
 *   KILLED      →  CustomMessagingReceiver starts native OrderAlertService directly
 *                  (no JS dependency for background/killed NEW_ORDER)
 *
 * Notification Actions (ACCEPT/REJECT):
 *   App alive  →  DeviceEventEmitter receives from NotificationHelperModule
 *   App killed →  HeadlessJsTask runs the JS task, which calls the API directly
 *
 * Sound:
 *   The persisted "Notification Sound" preference (src/config/notificationSound,
 *   stored in Android SharedPreferences) gates the alert AUDIO only. This file
 *   fires the new-order haptic when a push is claimed, so with sound OFF the
 *   alert still vibrates — in the foreground through vibrateOrderAlert(), in
 *   background / killed through the notification channel's pattern.
 */

import {
  Platform,
  PermissionsAndroid,
  NativeModules,
  DeviceEventEmitter,
  AppRegistry,
} from 'react-native';
import {
  getMessaging,
  getToken,
  onMessage,
  onTokenRefresh,
  getInitialNotification,
  onNotificationOpenedApp,
  setBackgroundMessageHandler,
} from '@react-native-firebase/messaging';
import type { RemoteMessage } from '@react-native-firebase/messaging';
import { apiPost } from './api.client';
import {
  claimNewOrderAlert,
  applyOrderDecision,
  dismissStaleAlert,
  resetOrderAlertState,
  activeAlertsSnapshot,
} from './orderAlertSync';

/* ── Types ── */

/** Expected FCM data payload from the backend. */
export interface OrderNotificationData {
  type: 'NEW_ORDER';
  orderId: string;
  orderNumber?: string;
  customerName: string;
  customerPhone?: string;
  address?: string;
  itemCount: string;
  total: string;
  paymentMethod?: string;
  paymentStatus?: string;
  items?: string; // JSON array string
}

/** FCM data payload sent when any device decides a pending order. */
export interface OrderStatusUpdatedData {
  type: 'ORDER_STATUS_UPDATED';
  eventType: 'ORDER_STATUS_UPDATED';
  eventId: string;
  orderId: string;
  orderNumber?: string;
  /** ACCEPTED | REJECTED (plus any later status the backend announces). */
  status: string;
  decision?: string;
}

/** Event kinds this service routes. */
export type OrderEventType = 'NEW_ORDER' | 'ORDER_STATUS_UPDATED';

/** Action payload emitted by the native layer. */
export interface NotificationActionPayload {
  action: 'ORDER_ACCEPT' | 'ORDER_REJECT';
  orderId: string;
}

/** Callback types. */
export type IncomingOrderHandler = (data: OrderNotificationData) => void;
export type NotificationActionHandler = (
  payload: NotificationActionPayload,
) => void;

/* ── Internal state ── */

let onIncomingOrder: IncomingOrderHandler | null = null;
let onNotificationAction: NotificationActionHandler | null = null;
let onTappedOrder: ((orderId: string) => void) | null = null;
let unsubscribeForeground: (() => void) | null = null;
let unsubscribeNotificationOpened: (() => void) | null = null;
let unsubscribeActionEvent: { remove: () => void } | null = null;
let unsubscribeTapEvent: { remove: () => void } | null = null;
let unsubscribeTokenRefresh: (() => void) | null = null;

// Duplicate protection: track processed order+action combos
const processedActions = new Set<string>();

/**
 * Foreground NEW_ORDER that arrived while nothing was listening.
 *
 * OrdersScreen registers the incoming-order handler and unregisters it when it
 * unmounts — which happens on every navigation to Settings / Notification
 * Settings. Without buffering, a push landing in that window was received by
 * the FCM listener and then silently thrown away.
 */
let bufferedIncomingOrder: OrderNotificationData | null = null;

/**
 * Orders already surfaced as an alert on this device live in
 * src/services/orderAlertSync (active set + decided-order tombstones), which
 * is also where an ORDER_STATUS_UPDATED cleanup lands. Re-exported here so the
 * foreground push, the buffered replay, the tap and the killed-launch path all
 * share the one guard.
 */
export function markOrderAlerted(orderId: string | undefined | null): boolean {
  return claimNewOrderAlert(orderId);
}

/**
 * Initialization guard. Keyed by user id so a logout → login — or a switch to
 * a different account, which must own the device token row on the backend —
 * re-runs registration instead of being skipped forever.
 */
let initializedForUser: string | null = null;
let initInFlight: Promise<void> | null = null;
let registrationRetryTimer: ReturnType<typeof setTimeout> | null = null;
let registrationRetryAttempts = 0;

/* ── Constants ── */

const NATIVE_MODULE = NativeModules.NotificationHelper as
  | {
      showOrderNotification: (data: {
        orderId: string;
        customerName: string;
        itemCount: string;
        total: string;
      }) => void;
      dismissNotification: (orderId: string) => void;
      startForegroundSound: () => void;
      stopForegroundSound: () => void;
      startOrderAlert: (data: {
        orderId: string;
        orderNumber: string;
        customerName: string;
        customerPhone: string;
        address: string;
        total: string;
        paymentMethod: string;
        paymentStatus: string;
        items: string;
      }) => void;
      stopOrderAlert: () => void;
      /** One haptic burst for a claimed foreground alert (pattern lives in Kotlin) */
      vibrateOrderAlert: () => void;
      getTappedOrderId: () => Promise<string | null>;
    }
  | undefined;

export const ORDER_CHANNEL_ID = 'sajjanmart_orders';
const HEADLESS_TASK_NAME = 'NotificationActionTask';

/** Backoff between device-token registration attempts (ms). */
const REGISTRATION_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/* ──────────────────────────────────────────────────────────────────────
 * Permission
 * ────────────────────────────────────────────────────────────────────── */

export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;

  if (Platform.Version >= 33) {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      {
        title: 'Sajjan Mart',
        message: 'Allow Sajjan Mart to send you order notifications?',
        buttonPositive: 'Allow',
        buttonNegative: 'Deny',
      },
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  }

  return true;
}

/* ──────────────────────────────────────────────────────────────────────
 * FCM Token
 * ────────────────────────────────────────────────────────────────────── */

export async function getFCMToken(): Promise<string | null> {
  try {
    const m = getMessaging();
    const token = await getToken(m);
    if (__DEV__) {
      console.log('[FCM] FCM Token obtained (not logged for security)');
    }
    return token;
  } catch (error) {
    if (__DEV__) {
      console.error('[FCM] Failed to get token:', error);
    }
    return null;
  }
}

export async function registerFCMToken(token: string): Promise<boolean> {
  if (!token || token.length === 0) {
    if (__DEV__) {
      console.log('[FCM] token received: no — skipping registration');
      console.log('[FCM] token registration result: skipped (no token)');
    }
    scheduleDeviceRegistrationRetry();
    return false;
  }

  if (__DEV__) {
    console.log('[FCM] token received: yes');
    console.log('[FCM] token length:', token.length);
    console.log('[FCM] registering device');
  }

  try {
    await apiPost<unknown>('/api/notifications/register-device', {
      fcmToken: token,
      platform: 'android',
    });
    if (__DEV__) {
      console.log('[FCM] register-device response: success');
      console.log('[FCM] device registration successful');
      console.log('[FCM] token registration result: success');
    }
    clearDeviceRegistrationRetry();
    return true;
  } catch (error: unknown) {
    const status = error instanceof Error ? error.message : String(error);
    if (__DEV__) {
      console.log('[FCM] register-device response:', status);
      console.log('[FCM] token registration result: failed —', status);
      console.log(
        '[FCM] device registration failed — will retry with backoff',
      );
    }
    scheduleDeviceRegistrationRetry();
    return false;
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * Device registration retry
 *
 * A cold start can race the network (offline, or the auth token not yet
 * restored), so a failed registration is retried with backoff instead of
 * being silently dropped until the next manual login.
 * ────────────────────────────────────────────────────────────────────── */

function clearDeviceRegistrationRetry(): void {
  if (registrationRetryTimer) {
    clearTimeout(registrationRetryTimer);
    registrationRetryTimer = null;
  }
  registrationRetryAttempts = 0;
}

function scheduleDeviceRegistrationRetry(): void {
  if (registrationRetryTimer) return;

  const delay = REGISTRATION_RETRY_DELAYS_MS[registrationRetryAttempts];
  if (delay === undefined) {
    if (__DEV__) {
      console.log(
        '[FCM] token registration retries exhausted — will retry on next login or token refresh',
      );
    }
    return;
  }

  registrationRetryAttempts += 1;
  if (__DEV__) {
    console.log(
      `[FCM] token registration retry scheduled in ${delay}ms (attempt ${registrationRetryAttempts})`,
    );
  }

  registrationRetryTimer = setTimeout(() => {
    registrationRetryTimer = null;
    retryDeviceRegistration();
  }, delay);
}

async function retryDeviceRegistration(): Promise<void> {
  if (__DEV__) {
    console.log('[FCM] retrying FCM token retrieval + device registration');
  }
  const token = await getFCMToken();
  // A failure here re-schedules the next backoff step via registerFCMToken.
  await registerFCMToken(token ?? '');
}

/* ──────────────────────────────────────────────────────────────────────
 * Native Notification Channel
 * ────────────────────────────────────────────────────────────────────── */

function ensureNotificationChannel(): void {
  if (Platform.OS !== 'android' || !NATIVE_MODULE) return;
  try {
    if (__DEV__) {
      console.log('[FCM] Notification channel check completed');
    }
  } catch (error) {
    console.error('[FCM] Failed to ensure notification channel:', error);
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * Initialisation
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Initialise FCM for the current authenticated session.
 *
 * Idempotent and concurrency-safe: repeated calls (e.g. App.tsx's effect plus
 * a login flow) resolve against the same in-flight run, and a second call for
 * the already-initialised user is a no-op.
 */
export async function initializeNotifications(
  userId?: string | null,
): Promise<void> {
  const userKey = userId ?? 'session';

  if (initializedForUser === userKey) {
    if (__DEV__) {
      console.log(
        '[FCM] Initialization skipped — already initialized for this session',
      );
    }
    return;
  }

  if (initInFlight) {
    if (__DEV__) {
      console.log('[FCM] Initialization skipped — initialization in progress');
    }
    await initInFlight;
    return;
  }

  initInFlight = runNotificationInit(userKey).finally(() => {
    initInFlight = null;
  });

  await initInFlight;
}

/**
 * Forget the initialization guard so the next authenticated session runs
 * initialization again. Listeners are left untouched — every subscription in
 * this module unsubscribes its predecessor before registering, so a second
 * initialization cannot create duplicate listeners.
 */
export function resetNotificationInitialization(): void {
  initializedForUser = null;
  clearDeviceRegistrationRetry();
  // A different account must not inherit this device's alert set or its
  // decided-order tombstones (nor the reverse: signing out clears the state a
  // re-login would otherwise suppress against).
  resetOrderAlertState();
  if (__DEV__) {
    console.log('[FCM] Notification initialization guard reset');
  }
}

async function runNotificationInit(userKey: string): Promise<void> {
  if (__DEV__) {
    console.log('[FCM] Notification initialization started');
  }

  // Permission + token registration must never prevent the listeners below
  // from being registered (e.g. offline cold start).
  try {
    const permissionGranted = await requestNotificationPermission();
    if (__DEV__) {
      console.log(
        `[FCM] Permission status: ${permissionGranted ? 'granted' : 'denied'}`,
      );
    }

    // An empty token is handled inside registerFCMToken: it logs the miss and
    // schedules a retry, since getToken() can fail on a cold/offline start.
    const token = await getFCMToken();
    await registerFCMToken(token ?? '');
  } catch (error) {
    if (__DEV__) {
      console.log(
        '[FCM] Notification initialization step failed — continuing with listeners:',
        error instanceof Error ? error.message : String(error),
      );
    }
    scheduleDeviceRegistrationRetry();
  }

  ensureNotificationChannel();

  // Clean up previous token refresh listener to prevent duplicates
  if (unsubscribeTokenRefresh) {
    unsubscribeTokenRefresh();
    unsubscribeTokenRefresh = null;
  }

  const m = getMessaging();
  const tokenSub = onTokenRefresh(m, newToken => {
    if (__DEV__) {
      console.log('[FCM] Token refreshed');
    }
    registerFCMToken(newToken);
  });
  unsubscribeTokenRefresh = tokenSub;

  startForegroundListener();
  startNotificationOpenedListener();
  startActionEventListener();
  startTapEventListener();

  initializedForUser = userKey;

  if (__DEV__) {
    console.log('[FCM] Initialization complete');
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * Foreground Messages
 *
 * When the app is in the foreground, the CustomMessagingReceiver does NOT
 * start OrderAlertService (to avoid duplicate notifications). Instead,
 * this handler fires and the JS modal takes over.
 * ────────────────────────────────────────────────────────────────────── */

export function setIncomingOrderHandler(handler: IncomingOrderHandler): void {
  onIncomingOrder = handler;

  // Deliver any NEW_ORDER that landed while no screen was registered.
  if (bufferedIncomingOrder) {
    const buffered = bufferedIncomingOrder;
    bufferedIncomingOrder = null;
    if (__DEV__) {
      console.log(
        `[FCM] Replaying buffered NEW_ORDER for order ${buffered.orderId}`,
      );
    }
    handler(buffered);
  }
}

export function removeIncomingOrderHandler(): void {
  onIncomingOrder = null;
}

function startForegroundListener(): void {
  if (unsubscribeForeground) {
    unsubscribeForeground();
  }

  const m = getMessaging();
  if (__DEV__) {
    console.log('[FCM] Foreground listener registered');
  }

  unsubscribeForeground = onMessage(m, (remoteMessage: RemoteMessage) => {
    const data = remoteMessage.data as Record<string, string> | undefined;
    if (!data) return;
    routeOrderEventData(data, 'foreground');
  });
}

/**
 * The one place that understands an order push, shared by the foreground
 * listener, the background handler and the notification-opened path so a
 * status cleanup can never be handled in one state and forgotten in another.
 */
export function routeOrderEventData(
  data: Record<string, string>,
  source: 'foreground' | 'background' | 'opened',
): void {
  const eventType = eventTypeOf(data);

  if (eventType === 'ORDER_STATUS_UPDATED') {
    handleOrderStatusUpdated(data, source);
    return;
  }

  if (eventType !== 'NEW_ORDER') {
    if (__DEV__) {
      console.log(
        `[FCM] ${source} message ignored, type:`,
        data.type ?? data.eventType ?? 'none',
      );
    }
    return;
  }

  const orderId = String(data.orderId ?? '');

  // The backend sends exactly one push per settled payment, but a delivery
  // retry, a replayed buffer or a second listener must not open a second modal
  // or a second alert loop for an order already on screen — and must never
  // re-surface an order another device already decided.
  if (!claimNewOrderAlert(orderId, data.orderNumber)) {
    if (__DEV__) {
      console.log(`[FCM] ${source} NEW_ORDER ignored for order ${orderId}`);
    }
    return;
  }

  const incoming = data as unknown as OrderNotificationData;

  if (source !== 'foreground') {
    // No JS UI exists in the background/killed runtime; the native alert is
    // already running and the order is recorded so the next foreground render
    // reconciles instead of re-alerting. The notification it posted already
    // vibrated, so this path must not buzz a second time.
    return;
  }

  // Claimed exactly once per order, so this is one haptic per alert — a delivery
  // retry or a replayed buffer returns at the claim above.
  vibrateForNewOrderAlert();

  if (onIncomingOrder) {
    if (__DEV__) {
      console.log(`[FCM] Foreground NEW_ORDER handled for order ${orderId}`);
    }
    onIncomingOrder(incoming);
    return;
  }

  bufferedIncomingOrder = incoming;
  if (__DEV__) {
    console.log(
      `[FCM] No order handler registered — buffered NEW_ORDER for order ${orderId}`,
    );
  }
}

/**
 * Handle an ORDER_STATUS_UPDATED push — another device (or this one) decided
 * the order, so the alert must disappear everywhere: sound stops, the pending
 * modal closes through its subscriber, the notification is cancelled by its
 * order-derived id and the cached row flips to the new status.
 */
function handleOrderStatusUpdated(
  data: Record<string, string>,
  source: 'foreground' | 'background' | 'opened',
): void {
  const orderId = String(data.orderId ?? '');
  if (!orderId) return;

  const payload = data as unknown as OrderStatusUpdatedData;

  if (__DEV__) {
    console.log(
      `[FCM] ${source} ORDER_STATUS_UPDATED for order ${orderId} → ${
        payload.status ?? payload.decision ?? 'unknown'
      }`,
    );
  }

  applyOrderDecision(orderId, payload.status ?? payload.decision);
}

/** Accepts both the new `eventType` key and the legacy `type` key. */
function eventTypeOf(
  data: Record<string, string>,
): OrderEventType | null {
  const raw = String(data.eventType ?? data.type ?? '');
  return raw === 'NEW_ORDER' || raw === 'ORDER_STATUS_UPDATED' ? raw : null;
}

export function stopForegroundListener(): void {
  if (unsubscribeForeground) {
    unsubscribeForeground();
    unsubscribeForeground = null;
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * Native Notification Display
 *
 * Shows an Android notification with ACCEPT / REJECT action buttons.
 * ────────────────────────────────────────────────────────────────────── */

export function showNativeOrderNotification(data: OrderNotificationData): void {
  if (Platform.OS !== 'android' || !NATIVE_MODULE) return;

  NATIVE_MODULE.showOrderNotification({
    orderId: data.orderId,
    customerName: data.customerName,
    itemCount: data.itemCount,
    total: data.total,
  });
}

export function dismissNotification(orderId: string): void {
  if (Platform.OS !== 'android' || !NATIVE_MODULE) return;
  NATIVE_MODULE.dismissNotification(orderId);
}

/* ──────────────────────────────────────────────────────────────────────
 * Native Order Alert Sound (for foreground JS start)
 *
 * Starts the foreground service from JS when the app is in foreground.
 * In background/killed, CustomMessagingReceiver starts it directly.
 * ────────────────────────────────────────────────────────────────────── */

export function startNativeOrderAlert(data: OrderNotificationData): void {
  if (Platform.OS !== 'android' || !NATIVE_MODULE) return;

  NATIVE_MODULE.startOrderAlert({
    orderId: data.orderId,
    orderNumber: data.orderNumber || data.orderId,
    customerName: data.customerName,
    customerPhone: data.customerPhone || '',
    address: data.address || '',
    total: data.total,
    paymentMethod: data.paymentMethod || '',
    paymentStatus: data.paymentStatus || '',
    items: data.items || '[]',
  });
}

export function stopNativeOrderAlert(): void {
  if (Platform.OS !== 'android' || !NATIVE_MODULE) return;
  NATIVE_MODULE.stopOrderAlert();
}

/**
 * Fire the new-order haptic.
 *
 * Never checks the sound preference — sound OFF must still vibrate. It runs
 * only for a claimed foreground push, which is the single JS vibration point:
 * a foreground alert posts no system notification (the modal is the UI), and
 * background / killed alerts vibrate through the notification channel instead.
 */
function vibrateForNewOrderAlert(): void {
  if (Platform.OS !== 'android' || !NATIVE_MODULE?.vibrateOrderAlert) return;
  try {
    NATIVE_MODULE.vibrateOrderAlert();
  } catch (error) {
    console.warn(
      '[FCM] New-order haptic failed:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * Notification Tap (NEW_ORDER notification click → JS)
 *
 * Cold start: MainActivity stashes order_id → JS pulls consumeTappedOrderId().
 * App running: MainActivity pushes "NotificationTap" → tap event listener.
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Pull (and clear) the order id stashed by MainActivity from a
 * NEW_ORDER notification tap. Resolves null when there is no pending tap.
 */
export function consumeTappedOrderId(): Promise<string | null> {
  if (Platform.OS !== 'android' || !NATIVE_MODULE) {
    return Promise.resolve(null);
  }
  return NATIVE_MODULE.getTappedOrderId();
}

export function setTappedOrderHandler(
  handler: ((orderId: string) => void) | null,
): void {
  onTappedOrder = handler;
}

export function removeTappedOrderHandler(): void {
  onTappedOrder = null;
}

/** Listen for notification-tap events pushed by MainActivity while the app is alive. */
function startTapEventListener(): void {
  if (unsubscribeTapEvent) {
    unsubscribeTapEvent.remove();
  }

  unsubscribeTapEvent = DeviceEventEmitter.addListener(
    'NotificationTap',
    (payload: { orderId?: string }) => {
      if (__DEV__) {
        console.log(
          `[ORDER-TAP] Notification tapped for order ${
            payload?.orderId ?? 'unknown'
          }`,
        );
      }
      if (payload?.orderId && onTappedOrder) {
        onTappedOrder(payload.orderId);
      }
    },
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Notification Actions (ACCEPT / REJECT)
 *
 * Two paths:
 *   1. App alive  → DeviceEventEmitter receives from NotificationHelperModule
 *   2. App killed → HeadlessJsTask runs the JS task, which calls processAction
 * ────────────────────────────────────────────────────────────────────── */

export function setNotificationActionHandler(
  handler: NotificationActionHandler,
): void {
  onNotificationAction = handler;
}

export function removeNotificationActionHandler(): void {
  onNotificationAction = null;
}

/** Listen for native action events when the app is alive. */
function startActionEventListener(): void {
  if (unsubscribeActionEvent) {
    unsubscribeActionEvent.remove();
  }

  unsubscribeActionEvent = DeviceEventEmitter.addListener(
    'NotificationAction',
    (payload: NotificationActionPayload) => {
      if (__DEV__) {
        console.log(
          `[ORDER-ACTION] ${
            payload.action === 'ORDER_ACCEPT' ? 'ACCEPT' : 'REJECT'
          } for order ${payload.orderId}`,
        );
      }
      processAction(payload.action, payload.orderId);
    },
  );
}

/**
 * Process a notification action (ACCEPT or REJECT).
 * Handles duplicate protection and notification dismissal.
 * Called from both JS event listener and HeadlessJsTask.
 */
export function processAction(
  action: 'ORDER_ACCEPT' | 'ORDER_REJECT',
  orderId: string,
): void {
  const key = `${action}:${orderId}`;

  // Duplicate protection
  if (processedActions.has(key)) {
    if (__DEV__) {
      console.log(`[ORDER-ACTION] Duplicate action ignored: ${key}`);
    }
    return;
  }
  processedActions.add(key);

  // Dismiss the notification
  dismissNotification(orderId);

  // Notify the JS layer
  if (onNotificationAction) {
    onNotificationAction({ action, orderId });
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * Notification Opened (background / killed)
 * ────────────────────────────────────────────────────────────────────── */

function startNotificationOpenedListener(): void {
  if (unsubscribeNotificationOpened) {
    unsubscribeNotificationOpened();
  }

  const m = getMessaging();
  unsubscribeNotificationOpened = onNotificationOpenedApp(
    m,
    (remoteMessage: RemoteMessage) => {
      if (__DEV__) {
        console.log('[FCM] Notification opened (background)');
      }
      const data = remoteMessage.data as Record<string, string> | undefined;
      if (!data) return;
      // The app is foreground now, so the open is just another delivery of the
      // same event and goes through the shared router (dedupe included).
      routeOrderEventData(data, 'foreground');
    },
  );
}

export async function handleInitialNotification(): Promise<OrderNotificationData | null> {
  try {
    const m = getMessaging();
    const remoteMessage = await getInitialNotification(m);

    if (remoteMessage?.data) {
      if (__DEV__) {
        console.log('[FCM] Notification opened (killed)');
      }
      return remoteMessage.data as unknown as OrderNotificationData;
    }
  } catch (error) {
    console.error('[FCM] Error handling initial notification:', error);
  }

  return null;
}

/* ──────────────────────────────────────────────────────────────────────
 * Background Message Handler
 *
 * For NEW_ORDER: CustomMessagingReceiver handles this natively by starting
 * OrderAlertService directly (and never dispatches here). This handler is a
 * safety net for the case where the JS runtime does receive it: it claims the
 * order first, so an order this device already resolved never rings again.
 *
 * For ORDER_STATUS_UPDATED: the native receiver stops the siren and cancels the
 * order's notification without JS; this handler runs the same cleanup through
 * the shared alert-sync layer so the cache/modal state is right the moment the
 * app is opened again.
 * ────────────────────────────────────────────────────────────────────── */

export function registerBackgroundHandler(): void {
  const m = getMessaging();
  setBackgroundMessageHandler(m, async (remoteMessage: RemoteMessage) => {
    const data = remoteMessage.data as Record<string, string> | undefined;
    if (!data) return;

    if (__DEV__) {
      console.log(
        '[FCM] Background message received, type:',
        data.eventType ?? data.type ?? 'unknown',
      );
    }

    const eventType = eventTypeOf(data);

    if (eventType === 'NEW_ORDER') {
      // Claim before ringing — a decided order must never start the alert.
      const claimed = claimNewOrderAlert(data.orderId, data.orderNumber);
      if (claimed && Platform.OS === 'android' && NATIVE_MODULE) {
        NATIVE_MODULE.startOrderAlert({
          orderId: data.orderId || '',
          orderNumber: data.orderNumber || data.orderId || '',
          customerName: data.customerName || '',
          customerPhone: data.customerPhone || '',
          address: data.address || '',
          total: data.total || '',
          paymentMethod: data.paymentMethod || '',
          paymentStatus: data.paymentStatus || '',
          items: data.items || '[]',
        });
      }
      return;
    }

    if (eventType === 'ORDER_STATUS_UPDATED') {
      const alertsLeftAfterCleanup = activeAlertsSnapshot().some(
        alert => alert.orderId !== String(data.orderId ?? ''),
      );
      routeOrderEventData(data, 'background');
      // The service holds one global siren. Silence it when no undecided
      // alert is left; the native receiver already stopped it when the
      // resolved order is the one it was ringing for.
      if (!alertsLeftAfterCleanup) {
        stopNativeOrderAlert();
      }
      return;
    }

    routeOrderEventData(data, 'background');
  });
}

/* ──────────────────────────────────────────────────────────────────────
 * HeadlessJsTask — handles actions when app is killed
 *
 * Registered at module scope in index.js.  When Android starts this
 * service, the JS runtime boots and runs the registered task.
 *
 * This handler directly calls the API — no dependency on React components,
 * App.tsx, or LoginScreen.
 * ────────────────────────────────────────────────────────────────────── */

export function registerHeadlessTask(): void {
  AppRegistry.registerHeadlessTask(HEADLESS_TASK_NAME, () => {
    return async (taskData: { data: { action: string; orderId: string } }) => {
      console.log('[FCM] Headless task running');

      const { action, orderId } = taskData?.data ?? {};
      if (!action || !orderId) {
        console.log('[FCM] Headless task: missing action or orderId');
        return;
      }

      const actionName = action === 'ORDER_ACCEPT' ? 'ACCEPT' : 'REJECT';
      console.log(
        `[ORDER-ACTION] Headless task: ${actionName} for order ${orderId}`,
      );

      try {
        // Import the order service directly — no React component dependency.
        // The API client reads the access token from AsyncStorage, which
        // is available in the headless JS context.
        const {
          acceptOrder,
          rejectOrder,
        } = require('../services/order.service');

        if (action === 'ORDER_ACCEPT') {
          console.log(`[ORDER-ACTION] Calling acceptOrder(${orderId})`);
          await acceptOrder(orderId);
          console.log('[ORDER-ACTION] API success — order accepted');
        } else if (action === 'ORDER_REJECT') {
          console.log(`[ORDER-ACTION] Calling rejectOrder(${orderId})`);
          await rejectOrder(orderId);
          console.log('[ORDER-ACTION] API success — order rejected');
        }

        // SUCCESS: this device holds the decision — run the full cleanup
        // (sound, notification, cache, decided-order tombstone) so a late
        // NEW_ORDER replay for the same order can never ring again.
        applyOrderDecision(
          orderId,
          action === 'ORDER_ACCEPT' ? 'ACCEPTED' : 'REJECTED',
        );
        console.log('[ORDER-ACTION] Notification dismissed');
      } catch (error: any) {
        // FAILURE: keep the notification visible so the user can see it
        // and potentially retry by tapping the app.
        const errorMsg = error?.message || String(error);
        console.error(
          `[ORDER-ACTION] API call failed for ${actionName} on order ${orderId}:`,
          errorMsg,
        );

        // A 409 means another device already decided it — the alert is stale,
        // not retryable. Dismiss it instead of keeping it up. The 409's own
        // message is free text, not a status, so the live status is read from
        // the order list; if that read fails the alert still closes.
        if (error?.status === 409) {
          console.log(
            `[ORDER-ACTION] Order ${orderId} was already decided on another device — dismissing stale alert`,
          );
          await dismissStaleAlert(orderId);
        }
        // Do NOT dismiss the notification on any other failure — it stays
        // visible as a persistent indicator that the action did not complete.
      }
    };
  });
}
