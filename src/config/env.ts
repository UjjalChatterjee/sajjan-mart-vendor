/**
 * Environment Configuration
 *
 * Centralised, non-hardcoded API base URL.
 *
 * Android Emulator: the emulator sees the host as 10.0.2.2.
 * Android Device / iOS Simulator: use your machine's LAN IP.
 * Override via:  react-native start --extra-packager-opts '{"host':'0.0.0.0"}'
 *
 * For production, swap the defaults below via your CI/CD or .env build step.
 */

import { Platform } from 'react-native';

/**
 * Default base URL varies by platform so Android doesn't hit "localhost".
 *
 * - iOS Simulator  → http://localhost:5000
 * - Android Emulator → http://10.0.2.2:5000  (maps to host machine)
 * - Android Device  → http://10.0.2.2:5000  (change to your LAN IP for physical device)
 */
const DEV_BASE_URL =
  Platform.OS === 'android' ? 'http://127.0.0.1:3000' : 'http://localhost:5000';

export const Env = {
  /** REST API base — no trailing slash */
  API_BASE_URL: __DEV__ ? DEV_BASE_URL : 'https://api.sajjanmart.com',

  /** API timeout in milliseconds */
  API_TIMEOUT: 15_000,
} as const;
