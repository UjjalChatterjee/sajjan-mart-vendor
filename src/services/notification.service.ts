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
 *   BACKGROUND  →  CustomMessagingService starts native OrderAlertService directly
 *   KILLED      →  CustomMessagingService starts native OrderAlertService directly
 *                  (no JS dependency for background/killed NEW_ORDER)
 *
 * Notification Actions (ACCEPT/REJECT):
 *   App alive  →  DeviceEventEmitter receives from NotificationHelperModule
 *   App killed →  HeadlessJsTask runs the JS task, which calls the API directly
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
import { apiPost } from './api.client';

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

export async function registerFCMToken(token: string): Promise<void> {
  if (!token || token.length === 0) {
    if (__DEV__) {
      console.log('[FCM] token received: no — skipping registration');
    }
    return;
  }

  if (__DEV__) {
    console.log('[FCM] token received: yes');
    console.log('[FCM] token length:', token.length);
    console.log('[FCM] registering device');
  }

  try {
    const result = await apiPost<unknown>('/api/notifications/register-device', {
      fcmToken: token,
      platform: 'android',
    });
    if (__DEV__) {
      console.log('[FCM] register-device response: success');
      console.log('[FCM] device registration successful');
    }
  } catch (error: unknown) {
    if (__DEV__) {
      const status = error instanceof Error ? error.message : String(error);
      console.log('[FCM] register-device response:', status);
      console.log('[FCM] device registration failed — will retry on token refresh');
    }
  }
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

export async function initializeNotifications(): Promise<void> {
  if (__DEV__) {
    console.log('[FCM] Initialization started');
  }

  const permissionGranted = await requestNotificationPermission();
  if (__DEV__) {
    console.log(`[FCM] Permission status: ${permissionGranted ? 'granted' : 'denied'}`);
  }

  const token = await getFCMToken();
  if (token) {
    await registerFCMToken(token);
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

  if (__DEV__) {
    console.log('[FCM] Initialization complete');
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * Foreground Messages
 *
 * When the app is in the foreground, the CustomMessagingService does NOT
 * start OrderAlertService (to avoid duplicate notifications). Instead,
 * this handler fires and the JS modal takes over.
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
    }

    try {
      const data = remoteMessage.data as Record<string, string> | undefined;
      if (!data) return;

      if (data.type === 'NEW_ORDER') {
        if (__DEV__) {
          console.log(`[FCM] NEW_ORDER received — orderId: ${data.orderId ?? 'unknown'}`);
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
 * In background/killed, CustomMessagingService starts it directly.
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
      console.log(`[ORDER-ACTION] ${payload.action === 'ORDER_ACCEPT' ? 'ACCEPT' : 'REJECT'} for order ${payload.orderId}`);
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
 * For NEW_ORDER: CustomMessagingService handles this natively by starting
 * OrderAlertService directly. This handler is a no-op for NEW_ORDER to
 * prevent duplicate service starts.
 *
 * For other message types: future handlers can be added here.
 * ────────────────────────────────────────────────────────────────────── */

export function registerBackgroundHandler(): void {
  const m = getMessaging();
  setBackgroundMessageHandler(m, async (remoteMessage: RemoteMessage) => {
    const data = remoteMessage.data as Record<string, string> | undefined;
    if (__DEV__) {
      console.log('[FCM] Background message received, type:', data?.type ?? 'unknown');
    }

    // NEW_ORDER is handled natively by CustomMessagingService.
    // As a safety net, also start OrderAlertService from JS in case
    // the native service missed it. OrderAlertService handles duplicates
    // gracefully (same orderId → no duplicate sound).
    if (data?.type === 'NEW_ORDER' && Platform.OS === 'android' && NATIVE_MODULE) {
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
      if (__DEV__) {
        console.log('[FCM] Headless task running');
      }

      const { action, orderId } = taskData?.data ?? {};
      if (!action || !orderId) {
        if (__DEV__) {
          console.log('[FCM] Headless task: missing action or orderId');
        }
        return;
      }

      if (__DEV__) {
        console.log(`[ORDER-ACTION] Headless task: ${action === 'ORDER_ACCEPT' ? 'ACCEPT' : 'REJECT'} for order ${orderId}`);
      }

      try {
        // Directly call the API service — no React component dependency
        const { acceptOrder, rejectOrder } = require('../services/order.service');

        if (action === 'ORDER_ACCEPT') {
          await acceptOrder(orderId);
          if (__DEV__) {
            console.log('[ORDER-ACTION] API success');
          }
        } else if (action === 'ORDER_REJECT') {
          await rejectOrder(orderId);
          if (__DEV__) {
            console.log('[ORDER-ACTION] API success');
          }
        }
      } catch (error) {
        if (__DEV__) {
          console.error('[ORDER-ACTION] API call failed:', error);
        }
      }

      // Dismiss notification
      dismissNotification(orderId);
    };
  });
}
