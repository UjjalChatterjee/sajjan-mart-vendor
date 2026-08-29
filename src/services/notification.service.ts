/**
 * Notification Service
 *
 * Centralised interface for Firebase Cloud Messaging (FCM) and
 * Android notification actions (ACCEPT / REJECT).
 *
 * Architecture:
 *   FCM Push  →  notification.service  →  Order Event  →  Order Store  →  UI
 */

import { Platform, PermissionsAndroid, NativeModules, DeviceEventEmitter, AppRegistry } from 'react-native';
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

/* ── Types ── */

/** Expected FCM data payload from the backend. */
export interface OrderNotificationData {
  type: 'NEW_ORDER';
  orderId: string;
  customerName: string;
  itemCount: string;
  total: string;
}

/** Action payload emitted by the native layer. */
export interface NotificationActionPayload {
  action: 'ORDER_ACCEPT' | 'ORDER_REJECT';
  orderId: string;
}

/** Callback types. */
export type IncomingOrderHandler = (data: OrderNotificationData) => void;
export type NotificationActionHandler = (payload: NotificationActionPayload) => void;

/* ── Internal state ── */

let onIncomingOrder: IncomingOrderHandler | null = null;
let onNotificationAction: NotificationActionHandler | null = null;
let unsubscribeForeground: (() => void) | null = null;
let unsubscribeNotificationOpened: (() => void) | null = null;
let unsubscribeActionEvent: { remove: () => void } | null = null;
let unsubscribeTokenRefresh: (() => void) | null = null;

// Duplicate protection: track processed order+action combos
const processedActions = new Set<string>();

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
    }
  | undefined;

export const ORDER_CHANNEL_ID = 'sajjanmart_orders';
const HEADLESS_TASK_NAME = 'NotificationActionTask';

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
      console.log(`[FCM] FCM Token: ${token}`);
      console.tron?.log({ message: `[FCM] FCM Token: ${token}` });
    }
    return token;
  } catch (error) {
    if (__DEV__) {
      console.error('[FCM] Failed to get token:', error);
      console.tron?.error({ message: '[FCM] Failed to get token', error: String(error) });
    }
    return null;
  }
}

export async function registerFCMToken(_token: string): Promise<void> {
  // TODO: POST token to backend /api/devices
}

/* ──────────────────────────────────────────────────────────────────────
 * Native Notification Channel
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Ensure the Android notification channel exists.
 * Called once during initialization so OrderAlertService
 * can reference it without error.
 */
function ensureNotificationChannel(): void {
  if (Platform.OS !== 'android' || !NATIVE_MODULE) return;
  try {
    // showOrderNotification with a dummy triggers ensureChannel() natively
    // But we don't want to show a notification — so we call the module
    // only if it exposes an explicit ensureChannel method.
    // For now, the channel is created lazily by NotificationHelperModule
    // when showOrderNotification() is called. OrderAlertService uses its
    // own channel. So this is a no-op placeholder for future use.
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

export async function initializeNotifications(): Promise<void> {
  if (__DEV__) {
    console.log('[FCM] Initialization started');
    console.tron?.log({ message: '[FCM] Initializing Firebase Messaging' });
  }

  const permissionGranted = await requestNotificationPermission();
  if (__DEV__) {
    console.log(`[FCM] Permission status: ${permissionGranted ? 'granted' : 'denied'}`);
    console.tron?.log({ message: `[FCM] Permission status: ${permissionGranted ? 'granted' : 'denied'}` });
  }

  const token = await getFCMToken();
  if (token) {
    await registerFCMToken(token);
  }

  // Ensure the notification channel exists (needed by OrderAlertService)
  ensureNotificationChannel();

  // Clean up previous token refresh listener to prevent duplicates
  if (unsubscribeTokenRefresh) {
    unsubscribeTokenRefresh();
    unsubscribeTokenRefresh = null;
  }

  const m = getMessaging();
  const tokenSub = onTokenRefresh(m, newToken => {
    if (__DEV__) {
      console.log(`[FCM] Token refreshed: ${newToken}`);
      console.tron?.log({ message: `[FCM] Token refreshed: ${newToken}` });
    }
    registerFCMToken(newToken);
  });
  unsubscribeTokenRefresh = tokenSub;

  startForegroundListener();
  startNotificationOpenedListener();
  startActionEventListener();

  if (__DEV__) {
    console.log('[FCM] Initialization complete');
    console.tron?.log({ message: '[FCM] Initialization complete' });
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * Foreground Messages
 * ────────────────────────────────────────────────────────────────────── */

export function setIncomingOrderHandler(handler: IncomingOrderHandler): void {
  onIncomingOrder = handler;
}

export function removeIncomingOrderHandler(): void {
  onIncomingOrder = null;
}

function startForegroundListener(): void {
  if (unsubscribeForeground) {
    unsubscribeForeground();
  }

  const m = getMessaging();
  unsubscribeForeground = onMessage(m, async (remoteMessage: RemoteMessage) => {
    if (__DEV__) {
      console.log('[FCM] Foreground message received');
      console.tron?.log({ message: '[FCM] Foreground message received', data: remoteMessage.data });
    }

    try {
      const data = remoteMessage.data as Record<string, string> | undefined;
      if (!data) return;

      if (data.type === 'NEW_ORDER') {
        if (__DEV__) {
          console.log(`[FCM] Message type: NEW_ORDER, Order ID: ${data.orderId}`);
          console.tron?.log({ message: `[FCM] NEW_ORDER from foreground — opening modal for ${data.orderId}` });
        }

        // Foreground: ONLY trigger the in-app modal.
        // Do NOT show a native Android notification — the NewOrderAlertModal
        // is the foreground UI. Native notifications are for background/killed.
        if (onIncomingOrder) {
          onIncomingOrder(data as unknown as OrderNotificationData);
        }
      }
    } catch (error) {
      console.error('[FCM] Error handling foreground message:', error);
      console.tron?.error({ message: '[FCM] Foreground handler error', error: String(error) });
    }
  });
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
 * Used by the background handler and foreground listener.
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
      console.log('[FCM] Notification action received:', payload);
      console.tron?.log({ message: `[ORDER] Action ${payload.action} for ${payload.orderId}` });
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
    console.log('[FCM] Duplicate action ignored:', key);
    console.tron?.warn({ message: `[ORDER] Duplicate action ignored: ${key}` });
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
      console.log('[FCM] Notification opened (background):', remoteMessage);
      console.tron?.log({ message: '[FCM] Notification opened from background' });
    }
      const data = remoteMessage.data as Record<string, string> | undefined;
      if (data?.type === 'NEW_ORDER' && onIncomingOrder) {
        onIncomingOrder(data as unknown as OrderNotificationData);
      }
    },
  );
}

export async function handleInitialNotification(): Promise<OrderNotificationData | null> {
  try {
    const m = getMessaging();
    const remoteMessage = await getInitialNotification(m);

    if (remoteMessage?.data) {
    if (__DEV__) {
      console.log('[FCM] Notification opened (killed):', remoteMessage);
      console.tron?.log({ message: '[FCM] Notification opened from killed state' });
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
 * ────────────────────────────────────────────────────────────────────── */

export function registerBackgroundHandler(): void {
  const m = getMessaging();
  setBackgroundMessageHandler(m, async (remoteMessage: RemoteMessage) => {
    if (__DEV__) {
      console.log('[FCM] Background message:', remoteMessage);
    }
    // Firebase shows a system notification automatically.
    // Our background handler in the future will build a custom
    // notification with ACCEPT / REJECT action buttons.
  });
}

/* ──────────────────────────────────────────────────────────────────────
 * HeadlessJsTask — handles actions when app is killed
 *
 * Registered at module scope in index.js.  When Android starts this
 * service, the JS runtime boots and runs the registered task.
 * ────────────────────────────────────────────────────────────────────── */

export function registerHeadlessTask(): void {
  AppRegistry.registerHeadlessTask(HEADLESS_TASK_NAME, () => {
    return async (taskData: { data: { action: string; orderId: string } }) => {
    if (__DEV__) {
      console.log('[FCM] Headless task running:', taskData);
      console.tron?.log({ message: `[FCM] Headless task: ${taskData?.data?.action} for ${taskData?.data?.orderId}` });
    }
      const { action, orderId } = taskData?.data ?? {};
      if (action && orderId) {
        processAction(
          action as 'ORDER_ACCEPT' | 'ORDER_REJECT',
          orderId,
        );
      }
    };
  });
}
