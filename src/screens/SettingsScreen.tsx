import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../theme/colors';
import { Toggle } from '../components/Toggle';
import { useNavigation } from '../context/NavigationContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { logout } from '../services/auth.service';
import { ConfirmModal, LogoutIcon } from '../components/ConfirmModal';
import {
  isNotificationSoundEnabled,
  loadNotificationSoundPreference,
  setNotificationSoundEnabled,
} from '../config/notificationSound';

/* ── Screen ── */

export function SettingsScreen() {
  const { goBack, resetHistoryToLogin } = useNavigation();
  const { signOut } = useAuth();
  const { showSuccess, showError } = useToast();
  const [logoutVisible, setLogoutVisible] = React.useState(false);

  /* The persisted "Notification Sound" preference — Android SharedPreferences,
   * the same file the native alert path reads. The cache gives the first frame
   * the right value; the mount load confirms it against storage. */
  const [soundOn, setSoundOn] = useState(isNotificationSoundEnabled());

  useEffect(() => {
    if (__DEV__) {
      console.log('[SCREEN] Rendering SettingsScreen (route: settings)');
    }

    let mounted = true;
    loadNotificationSoundPreference().then(stored => {
      if (mounted) setSoundOn(stored);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const handleSoundToggle = useCallback((next: boolean) => {
    setSoundOn(next);
    setNotificationSoundEnabled(next)
      .then(() => {
        showSuccess(
          next
            ? 'Notification sound turned on'
            : 'Notification sound turned off — alerts still vibrate',
        );
      })
      .catch(() => {
        // The write never reached storage, so the switch must not claim a state
        // native code will not honour.
        setSoundOn(previous => !previous);
        showError('Could not save the sound setting');
      });
  }, [showSuccess, showError]);

  const performLogout = async () => {
    setLogoutVisible(false);
    await logout();
    showSuccess('Logged out successfully');
    await signOut();
    resetHistoryToLogin();
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={goBack}
          activeOpacity={0.6}>
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Settings list */}
      <View style={styles.content}>
        {/* Alert preferences card — above Logout, same card language as the
            rest of the app (white card, 14-16 radius, gray borders). */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Order Alerts</Text>

          {/* Notification Sound — persisted in SharedPreferences, read by both
              the in-app audio path and the native background/killed alert. */}
          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingTitle}>Notification Sound</Text>
              <Text style={styles.settingDesc}>
                Play sound when a new order arrives
              </Text>
            </View>
            <Toggle value={soundOn} onValueChange={handleSoundToggle} />
          </View>

          <View style={styles.settingDivider} />

          {/* Vibration is not a preference — order alerts always vibrate, so
              there is no switch here to pretend otherwise. */}
          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingTitle}>Vibration</Text>
              <Text style={styles.settingDesc}>
                Always on. Order alerts vibrate even when the sound is off.
              </Text>
            </View>
            <View style={styles.alwaysOnBadge}>
              <Text style={styles.alwaysOnText}>Always On</Text>
            </View>
          </View>
        </View>

        {/* Logout */}
        <TouchableOpacity
          style={styles.logoutBtn}
          onPress={() => setLogoutVisible(true)}
          activeOpacity={0.6}>
          <LogoutIcon size={20} color={Colors.danger} />
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>

        {/* App version */}
        <View style={styles.version}>
          <Text style={styles.versionName}>Sajjan Mart</Text>
          <Text style={styles.versionNum}>Version 1.0.0</Text>
        </View>
      </View>

      {/* Logout Confirmation Modal */}
      <ConfirmModal
        visible={logoutVisible}
        title="Logout"
        message="Are you sure you want to logout from your account?"
        confirmLabel="LOGOUT"
        cancelLabel="CANCEL"
        confirmColor={Colors.danger}
        iconBackground="#FDE8E8"
        icon={<LogoutIcon size={28} color={Colors.danger} />}
        onCancel={() => setLogoutVisible(false)}
        onConfirm={performLogout}
      />
    </SafeAreaView>
  );
}

/* ── Styles ── */

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.screenBg,
  },
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backArrow: {
    fontSize: 20,
    color: Colors.gray700,
    fontWeight: '600',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.gray900,
  },
  // Content
  content: {
    flex: 1,
    paddingHorizontal: 18,
    paddingTop: 8,
  },
  // Alert preferences card
  card: {
    backgroundColor: Colors.white,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 18,
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.gray500,
    marginBottom: 14,
    letterSpacing: 0.3,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  settingInfo: {
    flex: 1,
    marginRight: 16,
  },
  settingTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.gray800,
    marginBottom: 2,
  },
  settingDesc: {
    fontSize: 13,
    color: Colors.gray500,
    lineHeight: 18,
  },
  settingDivider: {
    height: 1,
    backgroundColor: '#F3F4F6',
    marginVertical: 14,
  },
  alwaysOnBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: Colors.primaryTintSoft,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  alwaysOnText: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.primary,
  },
  // Logout
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 50,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#FCA5A5',
    backgroundColor: Colors.white,
    gap: 8,
    marginBottom: 24,
  },
  logoutText: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.danger,
  },
  // Version
  version: {
    alignItems: 'center',
  },
  versionName: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.gray400,
    marginBottom: 2,
  },
  versionNum: {
    fontSize: 12,
    color: Colors.gray400,
  },
});
