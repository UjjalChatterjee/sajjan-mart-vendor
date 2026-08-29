import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../theme/colors';
import { Toggle } from '../components/Toggle';
import { StatusBadge } from '../components/StatusBadge';
import { useNavigation } from '../context/NavigationContext';
import type { Order } from '../types';

/* ── Mock preview order ── */

const PREVIEW_ORDER: Order = {
  id: 'SM-1025',
  customerName: 'Rahul Das',
  customerPhone: '+91 98765 43210',
  deliveryAddress: '42, MG Road, Kolkata',
  status: 'pending',
  items: [
    { id: '1', name: 'Basmati Rice', quantity: 1, price: 420, total: 420, ready: false, cancelled: false },
    { id: '2', name: 'Amul Butter', quantity: 2, price: 56, total: 112, ready: false, cancelled: false },
    { id: '3', name: 'Onion', quantity: 3, price: 45, total: 135, ready: false, cancelled: false },
  ],
  subtotal: 622,
  discount: 0,
  deliveryCharge: 30,
  tax: 0,
  grandTotal: 652,
  createdAt: new Date().toISOString(),
};

function formatCurrency(amount: number): string {
  return `₹${amount.toLocaleString('en-IN')}`;
}

/* ── Screen ── */

export function NotificationSettingsScreen() {
  const { goBack } = useNavigation();
  const [enabled, setEnabled] = useState(true);
  const [soundOn, setSoundOn] = useState(true);
  const [vibrationOn, setVibrationOn] = useState(true);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={goBack} activeOpacity={0.6}>
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notifications</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>

        {/* ── Permission Section ── */}
        <View style={styles.card}>
          <View style={styles.permissionRow}>
            <View style={styles.permissionIcon}>
              <Text style={styles.permissionIconText}>🔔</Text>
            </View>
            <View style={styles.permissionInfo}>
              <Text style={styles.permissionTitle}>Order Notifications</Text>
              <Text style={styles.permissionDesc}>
                Get an instant alert whenever a new order arrives.
              </Text>
            </View>
          </View>

          <View style={styles.permissionStatus}>
            <View style={[
              styles.statusDot,
              { backgroundColor: enabled ? Colors.primary : Colors.warning },
            ]} />
            <Text style={[
              styles.statusText,
              { color: enabled ? Colors.primary : Colors.warning },
            ]}>
              {enabled ? 'Notifications Enabled' : 'Notifications Disabled'}
            </Text>
          </View>

          {!enabled && (
            <TouchableOpacity
              style={styles.enableBtn}
              onPress={() => setEnabled(true)}
              activeOpacity={0.7}>
              <Text style={styles.enableBtnText}>Enable Notifications</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Alert Settings ── */}
        <View style={styles.sectionLabel}>Alert Settings</View>

        <View style={styles.card}>
          {/* Sound */}
          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingTitle}>Sound</Text>
              <Text style={styles.settingDesc}>
                Play an alert sound when a new order arrives.
              </Text>
            </View>
            <Toggle
              value={soundOn && enabled}
              onValueChange={setSoundOn}
              disabled={!enabled}
            />
          </View>

          <View style={styles.settingDivider} />

          {/* Vibration */}
          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingTitle}>Vibration</Text>
              <Text style={styles.settingDesc}>
                Vibrate when a new order arrives.
              </Text>
            </View>
            <Toggle
              value={vibrationOn && enabled}
              onValueChange={setVibrationOn}
              disabled={!enabled}
            />
          </View>
        </View>

        {/* ── Notification Preview ── */}
        <View style={styles.sectionLabel}>Notification Preview</View>

        <View style={styles.previewCard}>
          {/* App name */}
          <Text style={styles.previewAppName}>Sajjan Mart</Text>

          {/* Notification body */}
          <View style={styles.previewBody}>
            <Text style={styles.previewNotifTitle}>
              🔔 New Order #{PREVIEW_ORDER.id}
            </Text>
            <Text style={styles.previewCustomer}>
              {PREVIEW_ORDER.customerName} • {PREVIEW_ORDER.items.length} items
            </Text>
            <Text style={styles.previewAmount}>
              {formatCurrency(PREVIEW_ORDER.grandTotal)}
            </Text>
          </View>

          {/* Mock actions */}
          <View style={styles.previewActions}>
            <View style={styles.previewRejectBtn}>
              <Text style={styles.previewRejectText}>Reject</Text>
            </View>
            <View style={styles.previewAcceptBtn}>
              <Text style={styles.previewAcceptText}>Accept</Text>
            </View>
          </View>
        </View>

        <Text style={styles.previewNote}>
          Preview only • Notifications will be powered by Android native + FCM
        </Text>

        <View style={{ height: 32 }} />
      </ScrollView>
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
    paddingHorizontal: 18,
  },
  // Cards
  card: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 18,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  // Permission
  permissionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  permissionIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: Colors.primaryTintSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  permissionIconText: {
    fontSize: 22,
  },
  permissionInfo: {
    flex: 1,
  },
  permissionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.gray900,
    marginBottom: 3,
  },
  permissionDesc: {
    fontSize: 13,
    color: Colors.gray500,
    lineHeight: 18,
  },
  permissionStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
  },
  enableBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
    elevation: 3,
  },
  enableBtnText: {
    color: Colors.white,
    fontSize: 14,
    fontWeight: '700',
  },
  // Section label
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.gray500,
    marginBottom: 10,
    letterSpacing: 0.3,
  },
  // Settings
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
  // Preview
  previewCard: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 16,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  previewAppName: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.gray800,
    marginBottom: 10,
  },
  previewBody: {
    marginBottom: 14,
  },
  previewNotifTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.gray900,
    marginBottom: 3,
  },
  previewCustomer: {
    fontSize: 13,
    color: Colors.gray600,
    marginBottom: 3,
  },
  previewAmount: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.primary,
  },
  previewActions: {
    flexDirection: 'row',
    gap: 10,
  },
  previewRejectBtn: {
    flex: 1,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: Colors.gray50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewRejectText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.gray600,
  },
  previewAcceptBtn: {
    flex: 1.3,
    height: 36,
    borderRadius: 10,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewAcceptText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.white,
  },
  previewNote: {
    fontSize: 12,
    color: Colors.gray400,
    textAlign: 'center',
    marginBottom: 8,
  },
});
