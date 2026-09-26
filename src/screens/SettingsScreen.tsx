import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../theme/colors';
import { useNavigation } from '../context/NavigationContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { logout } from '../services/auth.service';
import { ConfirmModal, LogoutIcon } from '../components/ConfirmModal';

/* ── Screen ── */

export function SettingsScreen() {
  const { goBack, resetHistoryToLogin } = useNavigation();
  const { signOut } = useAuth();
  const { showSuccess } = useToast();
  const [logoutVisible, setLogoutVisible] = React.useState(false);

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
