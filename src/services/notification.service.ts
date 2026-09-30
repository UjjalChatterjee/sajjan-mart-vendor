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
 *   FOREGROUND  →  onMessage() fires → JS shows modal + starts sound + haptic
 *   BACKGROUND  →  CustomMessagingReceiver starts native OrderAlertService directly
 *   KILLED      →  CustomMessagingReceiver starts native OrderAlertService directly
 *                  (no JS dependency for background/killed NEW_ORDER)
 *
 * The background / killed notification is generic by design — "Sajjan Mart" /
 * "1 New Order", no order details and no action buttons — and tapping it opens
 * the app on the Orders screen (see setOpenOrdersHandler()).
 *
 * Notification Actions (ACCEPT/REJECT):
 *   App alive  →  DeviceEventEmitter receives from NotificationHelperModule
 *   App killed →  HeadlessJsTask runs the JS task, which calls the API directly
 *
 * Sound:
 *   The persisted "Notification Sound" preference (src/config/notificationSound,
 *   stored in Android SharedPreferences) gates the alert AUDIO only.
 * Vibration:
 *   The repeating new-order haptic is owned by src/services/orderVibration.ts
 *   (one native loop, no JS timers) and is never gated by that preference:
 *   Sound OFF means a silent alert, not an invisible one.
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
import { syncApiBaseUrlToNative } from '../config/apiBaseUrl';
import {
  startOrderVibration,
  stopOrderVibration,
} from './orderVibration';
import {
  claimNewOrderAlert,
  applyOrderDecision,
  decidedStatusFor,
  dismissStaleAlert,
  isAlertActive,
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
let onOpenOrders: (() => void) | null = null;
let unsubscribeForeground: (() => void) | null = null;
let unsubscribeNotificationOpened: (() => void) | null = null;
let unsubscribeActionEvent: { remove: () => void } | null = null;
let unsubscribeTapEvent: { remove: () => void } | null = null;
let unsubscribeOpenOrdersEvent: { remove: () => void } | null = null;
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
      dismissNotification: (orderId: string) => void;
      startForegroundSound: () => void;
      stopForegroundSound: () => void;
      /** Only the order id crosses: the alert notification carries no order data */
      startOrderAlert: (data: { orderId: string }) => void;
      stopOrderAlert: () => void;
      /** Repeating haptic — one native loop, no JS timers */
      startOrderAlertVibration: () => void;
      stopOrderAlertVibration: () => void;
      getTappedOrderId: () => Promise<string | null>;
      getPendingOrdersNavigation: () => Promise<boolean>;
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
  // A different account must not inherit this device's alert set, its
  // decided-order tombstones or its repeating haptic — resetOrderAlertState()
  // releases the haptic as part of clearing the alerts, so the next session
  // cannot start from a motor that is still buzzing for the previous one.
  resetOrderAlertState();
  if (__DEV__) {
    console.log('[FCM] Notification initialization guard reset');
  }
}

async function runNotificationInit(userKey: string): Promise<void> {
  if (__DEV__) {
    console.log('[FCM] Notification initialization started');
  }

  // Publish the server address native code must call. This runs before anything
  // else and outside the try/catch below: a killed-app ACCEPT / REJECT is
  // handled entirely in Kotlin, and without this value it has no target — the
  // exact bug that made every background tap fail with "No connection".
  syncApiBaseUrlToNative();

  // Field diagnostic, logged unconditionally: the installed APK is the only
  // thing that can be missing the haptic bridge, and a release build that
  // cannot vibrate has to say so in the logs rather than fail silently.
  console.log(
    `[ORDER-VIBE] bridge at init: module=${NATIVE_MODULE ? 'present' : 'MISSING'} ` +
      `startOrderAlertVibration=${typeof NATIVE_MODULE?.startOrderAlertVibration}`,
  );

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
  startOpenOrdersListener();

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

    /* The buffer can sit in the runtime for a long time — it is flushed whenever
     * a screen registers the handler, including after the order was already
     * accepted or rejected while this screen was unmounted (navigating to
     * Settings, or a remote device's decision). Re-playing it then reopens the
     * alert of a settled order, which is exactly the "it popped up again after I
     * accepted it" failure. An alert only replays while it is still live. */
    if (decidedStatusFor(buffered.orderId) || !isAlertActive(buffered.orderId)) {
      if (__DEV__) {
        console.log(
          `[FCM] Buffered NEW_ORDER dropped — order ${buffered.orderId} is no longer awaiting a decision`,
        );
      }
      return;
    }

    if (__DEV__) {
      console.log(
        `[FCM] Replaying buffered NEW_ORDER for order ${buffered.orderId}`,
      );
    }
    // The screen that owned the repeating haptic may have unmounted (and
    // released it) in the meantime; re-arming for the same order is a no-op
    // while it is still vibrating, so the replayed alert is felt as well as
    // heard exactly like the original push.
    startOrderVibration(buffered.orderId);
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
    // already running — it owns the siren and the repeating haptic as
    // OrderVibration's service owner — and the order is recorded so the next
    // foreground render reconciles instead of re-alerting. Claiming a JS haptic
    // owner here would leave a second claim nobody ever releases.
    return;
  }

  /*
   * The repeating haptic belongs to the alert, not to the modal: it starts as
   * soon as this device claims the order, so a push that lands while no screen
   * has registered the incoming-order handler is still felt. Claimed exactly
   * once per order, so this cannot start a second loop — a delivery retry or a
   * replayed buffer returns at the claim above, and orderVibration.ts ignores a
   * repeat for the order it is already vibrating for.
   */
  startOrderVibration(orderId);

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
 * Native Notification Dismissal
 *
 * The alert notification itself is posted natively (OrderAlertService) and is
 * generic on purpose, so JS only ever clears notifications here.
 * ────────────────────────────────────────────────────────────────────── */

export function dismissNotification(orderId: string): void {
  if (Platform.OS !== 'android' || !NATIVE_MODULE) return;
  NATIVE_MODULE.dismissNotification(orderId);
}

/* ──────────────────────────────────────────────────────────────────────
 * Native Order Alert (background / killed foreground service)
 *
 * CustomMessagingReceiver starts that service natively, with no JS runtime
 * involved, so there is no JS-side start path here. The stop is exposed because
 * the runtime that resolves an order has to be able to end the alert.
 * ────────────────────────────────────────────────────────────────────── */

export function stopNativeOrderAlert(): void {
  if (Platform.OS !== 'android' || !NATIVE_MODULE) return;
  NATIVE_MODULE.stopOrderAlert();
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
 * Order-alert notification tap → Orders screen
 *
 * The background / killed alert notification is generic and carries no order, so
 * a tap means one thing: open the app on the Orders screen, where the staff can
 * see the order and decide it.
 *
 * Cold start: MainActivity stashes the flag → JS pulls consumePendingOrdersNavigation().
 * App running: MainActivity pushes "NotificationOpenOrders" → this listener.
 * ────────────────────────────────────────────────────────────────────── */

/** Pull (and clear) the "open the Orders screen" flag set by a notification tap. */
export function consumePendingOrdersNavigation(): Promise<boolean> {
  if (Platform.OS !== 'android' || !NATIVE_MODULE) {
    return Promise.resolve(false);
  }
  return NATIVE_MODULE.getPendingOrdersNavigation().catch(() => false);
}

/**
 * Register the screen router for a notification tap.
 *
 * Lives in App.tsx, not in a screen: the tap must work whichever screen is
 * showing (Settings, Notification Settings), and AppContent is the only place
 * that holds the navigation state.
 */
export function setOpenOrdersHandler(handler: (() => void) | null): void {
  onOpenOrders = handler;
}

export function removeOpenOrdersHandler(): void {
  onOpenOrders = null;
}

/** Listen for the generic alert notification's tap while the app is alive. */
function startOpenOrdersListener(): void {
  if (unsubscribeOpenOrdersEvent) {
    unsubscribeOpenOrdersEvent.remove();
  }

  unsubscribeOpenOrdersEvent = DeviceEventEmitter.addListener(
    'NotificationOpenOrders',
    () => {
      if (__DEV__) {
        console.log('[ORDER-TAP] Order alert notification tapped — opening Orders');
      }
      onOpenOrders?.();
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
 * Handles duplicate protection and hands the action to the JS layer.
 * Called from both JS event listener and HeadlessJsTask.
 *
 * It deliberately does NOT dismiss anything. The alert belongs to the
 * decision, not to the tap: applyOrderDecision() closes sound + notification +
 * cache once the backend confirms it, and dismissStaleAlert() closes a 409. If
 * the call fails — offline, expired session, server error — the alert stays in
 * the shade as the retry point instead of vanishing on an unconfirmed decision.
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

  // Notify the JS layer
  if (onNotificationAction) {
    onNotificationAction({ action, orderId });
    return;
  }

  // No screen is mounted to own this tap (OrdersScreen unmounted, or the app
  // was opened by the notification). Submitting here instead of only hiding the
  // notification is the whole point: the old code dismissed the alert without
  // ever calling the API, so the order stayed pending.
  void settleNotificationAction(action, orderId).then(settled => {
    if (!settled) {
      // The decision never reached the backend, so the alert is still live and
      // the admin may tap it again — release the dedupe claim for that retry.
      processedActions.delete(key);
    }
  });
}

/**
 * Submit an ACCEPT / REJECT decided from a notification when no screen owns it.
 *
 * Returns true when the backend settled the order (2xx, or 409 = decided
 * elsewhere, which is equally final). false means the alert must stay recoverable.
 *
 * Cleanup mirrors the native path exactly:
 *   2xx  → applyOrderDecision: stop sound, cancel this order's notification,
 *          record it as decided, patch the ['orders'] cache. The other admin
 *          devices clean themselves from the backend's ORDER_STATUS_UPDATED push.
 *   409  → dismissStaleAlert: another device won the atomic pending-exit claim,
 *          so this alert is stale rather than retryable.
 *   else → log the real reason and touch nothing else. The siren was already
 *          silenced by the receiver at the tap; the alert notification is still
 *          in the shade, and the Orders screen it opens is the retry point.
 */
export async function settleNotificationAction(
  action: 'ORDER_ACCEPT' | 'ORDER_REJECT',
  orderId: string,
): Promise<boolean> {
  const actionName = action === 'ORDER_ACCEPT' ? 'ACCEPT' : 'REJECT';

  try {
    // Imported lazily — order.service pulls in the API client and the store
    // layer, and a static import here would close a cycle through the screens
    // that register these handlers. This is also what makes the headless
    // runtime work: no component, no App.tsx, no login screen required.
    const { acceptOrder, rejectOrder } = require('../services/order.service') as {
      acceptOrder(id: string): Promise<unknown>;
      rejectOrder(id: string): Promise<unknown>;
    };

    if (action === 'ORDER_ACCEPT') {
      await acceptOrder(orderId);
    } else {
      await rejectOrder(orderId);
    }

    console.log(`[ORDER-ACTION] ${actionName} order ${orderId} confirmed by server`);
    applyOrderDecision(orderId, action === 'ORDER_ACCEPT' ? 'ACCEPTED' : 'REJECTED');
    return true;
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `[ORDER-ACTION] ${actionName} order ${orderId} NOT sent (status ${status ?? 'n/a'}): ${message}`,
    );

    if (status === 409) {
      console.log(
        `[ORDER-ACTION] Order ${orderId} was already decided on another device — dismissing stale alert`,
      );
      await dismissStaleAlert(orderId);
      return true;
    }
    return false;
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
        // Only the order id: the service's notification is generic, so no
        // customer, payment or address data enters it.
        NATIVE_MODULE.startOrderAlert({ orderId: data.orderId || '' });
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

      // Same single submit the no-screen branch of processAction uses: the API
      // call reads the access token from AsyncStorage (available in the headless
      // context), and cleanup / 409 / keep-the-alert rules cannot drift apart.
      await settleNotificationAction(
        action === 'ORDER_ACCEPT' ? 'ORDER_ACCEPT' : 'ORDER_REJECT',
        orderId,
      );
    };
  });
}
