/**
 * Reactotron Configuration — Sajjan Mart
 *
 * Development-only debugging tool.  Completely disabled in production.
 * Connects to the Reactotron desktop app over the local network.
 */

import Reactotron from 'reactotron-react-native';

const reactotron = Reactotron.configure({
  name: 'Sajjan Mart',
})
  .useReactNative({
    log: true,
    editor: true,
    errors: true,
  })
  .connect();

// Attach to console.tron for convenient access throughout the app
// eslint-disable-next-line @typescript-eslint/no-explicit-any
console.tron = reactotron as any;

export default reactotron;
