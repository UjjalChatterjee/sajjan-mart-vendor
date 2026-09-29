/**
 * The Settings screen the vendor actually opens must contain the
 * Notification Sound switch.
 *
 *   npx jest __tests__/settings-screen-renders.test.tsx
 *
 * Why this exists: the toggle was first added to NotificationSettingsScreen,
 * which no navigation call ever reaches — the only entry point in the app is
 * OrdersScreen → navigate('settings') → App.tsx route 'settings' →
 * SettingsScreen (App.tsx:110). This test renders the screen behind that route
 * and fails if the row is not on it.
 */

import React from 'react';
import { act, create } from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    SafeAreaView: (props: { children?: unknown }) =>
      ReactModule.createElement('SafeAreaView', null, props.children),
  };
});

/* Contexts and services are stand-ins: what matters is what the screen renders
 * and which callback a tap reaches. */
const mockSignOut = jest.fn();
const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();

jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ signOut: mockSignOut }),
}));
jest.mock('../src/context/ToastContext', () => ({
  useToast: () => ({ showSuccess: mockShowSuccess, showError: mockShowError }),
}));
jest.mock('../src/context/NavigationContext', () => ({
  useNavigation: () => ({
    goBack: jest.fn(),
    resetHistoryToLogin: jest.fn(),
    navigate: jest.fn(),
    canGoBack: false,
    state: { history: [{ screen: 'settings' }] },
  }),
}));
jest.mock('../src/services/auth.service', () => ({
  logout: jest.fn(async () => {}),
}));

const mockSetNotificationSoundEnabled = jest.fn(async (enabled: boolean) => enabled);
const mockLoadNotificationSoundPreference = jest.fn(async () => true);

jest.mock('../src/config/notificationSound', () => ({
  isNotificationSoundEnabled: () => true,
  loadNotificationSoundPreference: () => mockLoadNotificationSoundPreference(),
  setNotificationSoundEnabled: (enabled: boolean) =>
    mockSetNotificationSoundEnabled(enabled),
}));

import { SettingsScreen } from '../src/screens/SettingsScreen';
import { Toggle } from '../src/components/Toggle';

/** Text host nodes whose only rendered text is `wanted`. */
function findText(tree: ReturnType<typeof create>, wanted: string) {
  return tree.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.children.flat().some(child => String(child) === wanted),
  );
}

/**
 * The switch inside the row that carries the title: walk up from the title text
 * until an ancestor renders a Toggle, which is the row itself. The Vibration row
 * renders a static badge, so exactly one Toggle may exist on the screen.
 */
function soundToggle(tree: ReturnType<typeof create>) {
  const toggles = tree.root.findAllByType(Toggle);
  expect(toggles.length).toBe(1);

  let node = findText(tree, 'Notification Sound')[0].parent;
  while (node && node.findAllByType(Toggle).length === 0) {
    node = node.parent;
  }
  expect(node).toBeDefined();
  return node!.findAllByType(Toggle)[0];
}

beforeEach(() => {
  jest.clearAllMocks();
});

/** Mount, then flush the microtask the mount effect's stored-value read resolves
 *  on so no state update lands outside act(). */
async function mountSettings() {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<SettingsScreen />);
  });
  await act(async () => {});
  return tree;
}

async function unmount(tree: ReturnType<typeof create>) {
  await act(async () => {
    tree.unmount();
  });
}

describe('SettingsScreen — the screen behind the settings route', () => {
  it('renders the Notification Sound row above Logout, keeping the layout', async () => {
    const tree = await mountSettings();

    expect(findText(tree, 'Notification Sound').length).toBe(1);
    expect(findText(tree, 'Play sound when a new order arrives').length).toBe(1);
    expect(findText(tree, 'Vibration').length).toBe(1);
    expect(findText(tree, 'Always On').length).toBe(1);

    // The pre-existing content is still there.
    expect(findText(tree, 'Logout').length).toBe(1);
    expect(findText(tree, 'Version 1.0.0').length).toBe(1);

    // Sound row comes first in the settings list, before the logout button.
    const titles = tree.root
      .findAll(node => typeof node.type === 'string')
      .map(node => node.children.flat().map(String).join(''))
      .filter(text => ['Notification Sound', 'Logout'].includes(text));
    expect(titles).toEqual(['Notification Sound', 'Logout']);

    await unmount(tree);
  });

  it('starts from the stored value and writes taps back through the preference module', async () => {
    const tree = await mountSettings();

    expect(mockLoadNotificationSoundPreference).toHaveBeenCalledTimes(1);

    const toggle = soundToggle(tree);
    expect(toggle.props.value).toBe(true);

    await act(async () => {
      toggle.props.onValueChange(false);
    });

    expect(mockSetNotificationSoundEnabled).toHaveBeenCalledWith(false);
    expect(soundToggle(tree).props.value).toBe(false);
    expect(mockShowSuccess).toHaveBeenCalledWith(
      'Notification sound turned off — alerts still vibrate',
    );

    await unmount(tree);
  });

  it('puts the switch back when the write never reaches storage', async () => {
    mockSetNotificationSoundEnabled.mockRejectedValueOnce(new Error('bridge down'));

    const tree = await mountSettings();

    await act(async () => {
      soundToggle(tree).props.onValueChange(false);
    });
    await act(async () => {});

    expect(soundToggle(tree).props.value).toBe(true);
    expect(mockShowError).toHaveBeenCalledWith('Could not save the sound setting');

    await unmount(tree);
  });
});
