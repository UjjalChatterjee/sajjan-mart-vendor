/**
 * @format
 *
 * Entry point — registers the React app, FCM background handler,
 * and the HeadlessJsTask for notification actions in killed state.
 */

// Reactotron must be imported before anything else (dev only)
if (__DEV__) {
  require('./ReactotronConfig');
}

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import {
  registerBackgroundHandler,
  registerHeadlessTask,
} from './src/services/notification.service';
import { loadNotificationSoundPreference } from './src/config/notificationSound';

// Pull the persisted "Notification Sound" switch (Android SharedPreferences)
// into this JS runtime. Runs in every runtime start-up — main app, background
// message, headless task — so the in-app audio path matches what the native
// alert path reads directly from the same file. It never rejects: an
// unreachable bridge leaves the default in place, and the value is re-checked
// natively before any playback, so start-up never waits on it.
loadNotificationSoundPreference();

// Register the React app
AppRegistry.registerComponent(appName, () => App);

// Register FCM background message handler (must be at module scope)
registerBackgroundHandler();

// Register HeadlessJsTask for notification actions when app is killed
registerHeadlessTask();
