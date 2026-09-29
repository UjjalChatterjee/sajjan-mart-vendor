/**
 * Notification Sound Preference
 *
 * The user-facing "Notification Sound" switch (Settings → Notifications).
 *
 *   ON  → alert.mp3 plays for a new order, and the alert vibrates
 *   OFF → no audio, the alert STILL vibrates
 *
 * Storage: Android SharedPreferences (sajjanmart_notifications /
 * `order_alert_sound_enabled`), reached through the NotificationHelper native
 * module. That file is the ONE store — the native alert path
 * (CustomMessagingReceiver → OrderAlertService, which runs with no JS bundle at
 * all) reads it directly, so JavaScript and Kotlin can never disagree, and the
 * value survives app restart, force close and device reboot. There is
 * deliberately no AsyncStorage mirror: two stores would drift.
 *
 * Both playback paths are gated by the same value:
 *   Foreground     → sound.service.ts refuses to start the native MediaPlayer.
 *   Background /
 *   killed         → OrderAlertService skips playback but keeps its
 *                    notification, so vibration and ACCEPT / REJECT are intact.
 *
 * The in-memory cache below exists only so `isNotificationSoundEnabled()` can
 * stay synchronous for the audio path; it is filled from SharedPreferences as
 * soon as the JS runtime starts (index.js) and refreshed by the Settings screen.
 * It is never the source of truth.
 */

import { NativeModules, Platform } from 'react-native';

interface NotificationSoundBridge {
  getNotificationSoundEnabled(): Promise<boolean>;
  setNotificationSoundEnabled(enabled: boolean): void;
}

/** Default when no preference has ever been stored. */
const DEFAULT_SOUND_ENABLED = true;

const bridge =
  Platform.OS === 'android'
    ? (NativeModules.NotificationHelper as
        | (Pick<
            NotificationSoundBridge,
            'getNotificationSoundEnabled' | 'setNotificationSoundEnabled'
          > & Record<string, unknown>)
        | undefined)
    : undefined;

let cachedEnabled = DEFAULT_SOUND_ENABLED;

/** Whether the order-alert sound is currently allowed to play. */
export function isNotificationSoundEnabled(): boolean {
  return cachedEnabled;
}

/**
 * Read the persisted preference into the cache.
 *
 * Called at every JS runtime start-up (index.js) and when the Settings screen
 * mounts. A read failure leaves the cache untouched — an unreachable native
 * module is no reason to mute the user's alerts, and the audio paths re-check
 * the persisted value in native code anyway.
 */
export async function loadNotificationSoundPreference(): Promise<boolean> {
  if (!bridge?.getNotificationSoundEnabled) {
    if (__DEV__) {
      console.log(
        `[SOUND] Native bridge unavailable — using default ${
          DEFAULT_SOUND_ENABLED ? 'ON' : 'OFF'
        }`,
      );
    }
    return cachedEnabled;
  }

  try {
    const stored = await bridge.getNotificationSoundEnabled();
    cachedEnabled = typeof stored === 'boolean' ? stored : DEFAULT_SOUND_ENABLED;
    if (__DEV__) {
      console.log(`[SOUND] Notification sound loaded: ${cachedEnabled ? 'ON' : 'OFF'}`);
    }
  } catch (error) {
    console.warn(
      '[SOUND] Failed to load notification sound preference:',
      error instanceof Error ? error.message : String(error),
    );
  }

  return cachedEnabled;
}

/**
 * Persist the switch and update the cache.
 *
 * The cache only moves once the write has gone through, so the Settings UI can
 * never show a state that native code does not honour.
 */
export async function setNotificationSoundEnabled(
  enabled: boolean,
): Promise<boolean> {
  if (!bridge?.setNotificationSoundEnabled) {
    cachedEnabled = enabled;
    if (__DEV__) {
      console.log(
        '[SOUND] Native bridge unavailable — preference kept in memory only',
      );
    }
    return cachedEnabled;
  }

  try {
    bridge.setNotificationSoundEnabled(enabled);
    cachedEnabled = enabled;
    if (__DEV__) {
      console.log(`[SOUND] Notification sound ${enabled ? 'ON' : 'OFF'} persisted`);
    }
  } catch (error) {
    console.error(
      '[SOUND] Failed to persist notification sound preference:',
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }

  return cachedEnabled;
}

/**
 * Restore the default (ON) in-memory cache without touching storage.
 * Test-only: it simulates a freshly started JS runtime reading the store again.
 */
export function resetNotificationSoundPreferenceForTests(): void {
  cachedEnabled = DEFAULT_SOUND_ENABLED;
}
