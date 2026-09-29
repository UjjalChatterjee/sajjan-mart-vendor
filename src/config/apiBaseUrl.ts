/**
 * API Base URL — published to native code
 *
 * The killed-app ACCEPT / REJECT path (NotificationActionReceiver →
 * NativeOrderApiService) runs with no JS bundle, so it cannot import
 * `src/config/env`. It reads the address out of Android SharedPreferences
 * instead, which this module writes from the ONE source of truth,
 * `Env.API_BASE_URL`.
 *
 * Same single-store rule as the notification-sound switch: Kotlin holds no URL
 * of its own. That is what broke the killed-app actions — the native service
 * carried its own hardcoded `127.0.0.1` / `10.0.2.2` candidates and could never
 * reach the deployed backend, so every background tap failed.
 *
 * Storage: Android SharedPreferences (sajjanmart_notifications /
 * `api_base_url`) via NotificationHelper.setApiBaseUrl.
 */

import { NativeModules, Platform } from 'react-native';
import { Env } from './env';

interface ApiBaseUrlBridge {
  setApiBaseUrl(url: string): void;
  getApiBaseUrl(): Promise<string | null>;
}

const bridge =
  Platform.OS === 'android'
    ? (NativeModules.NotificationHelper as
        | (Pick<ApiBaseUrlBridge, 'setApiBaseUrl'> & Record<string, unknown>)
        | undefined)
    : undefined;

/**
 * Push the URL JS is using into the native store.
 *
 * Returns false when there is nothing to push (no bridge, or a rejected value) —
 * the caller only logs, because a native path that never learned the address
 * says so itself instead of guessing one.
 */
export function syncApiBaseUrlToNative(): boolean {
  if (!bridge?.setApiBaseUrl) {
    if (__DEV__) {
      console.log('[API-URL] Native bridge unavailable — native paths have no URL');
    }
    return false;
  }

  try {
    bridge.setApiBaseUrl(Env.API_BASE_URL);
    if (__DEV__) {
      console.log(`[API-URL] Published to native: ${Env.API_BASE_URL}`);
    }
    return true;
  } catch (error) {
    console.warn(
      '[API-URL] Failed to publish the API base URL:',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
