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

// Register the React app
AppRegistry.registerComponent(appName, () => App);

// Register FCM background message handler (must be at module scope)
registerBackgroundHandler();

// Register HeadlessJsTask for notification actions when app is killed
registerHeadlessTask();
