import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { Colors } from '../theme/colors';
import type { Order } from '../types';

interface StatusBadgeProps {
  status: Order['status'];
  size?: 'small' | 'medium';
  style?: ViewStyle;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  pending: {
    label: 'Pending',
    color: Colors.pending,
    bg: Colors.pendingLight,
  },
  accepted: {
    label: 'Accepted',
    color: Colors.accepted,
    bg: Colors.acceptedLight,
  },
  rejected: {
    label: 'Rejected',
    color: Colors.rejected,
    bg: Colors.rejectedLight,
  },
  confirmed: {
    label: 'Confirmed',
    color: '#2563EB',
    bg: '#DBEAFE',
  },
  processing: {
    label: 'Processing',
    color: '#7C3AED',
    bg: '#EDE9FE',
  },
  packed: {
    label: 'Packed',
    color: '#0891B2',
    bg: '#CFFAFE',
  },
  shipped: {
    label: 'Shipped',
    color: '#0D9488',
    bg: '#CCFBF1',
  },
  delivered: {
    label: 'Delivered',
    color: Colors.accepted,
    bg: Colors.acceptedLight,
  },
  cancelled: {
    label: 'Cancelled',
    color: Colors.rejected,
    bg: Colors.rejectedLight,
  },
  cancel_request: {
    label: 'Cancel Requested',
    color: Colors.warning,
    bg: Colors.warningLight,
  },
  return: {
    label: 'Return',
    color: Colors.warning,
    bg: Colors.warningLight,
  },
  refunded: {
    label: 'Refunded',
    color: Colors.gray500,
    bg: Colors.gray100,
  },
};

export function StatusBadge({ status, size = 'medium', style }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending;

  return (
    <View
      style={[
        styles.badge,
        styles[`${size}Badge`],
        { backgroundColor: config.bg },
        style,
      ]}>
      <View
        style={[
          styles.dot,
          styles[`${size}Dot`],
          { backgroundColor: config.color },
        ]}
      />
      <Text
        style={[
          styles.label,
          styles[`${size}Label`],
          { color: config.color },
        ]}>
        {config.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
  },
  mediumBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 6,
  },
  smallBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 4,
  },
  dot: {
    borderRadius: 999,
  },
  mediumDot: {
    width: 7,
    height: 7,
  },
  smallDot: {
    width: 5,
    height: 5,
  },
  label: {
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  mediumLabel: {
    fontSize: 12,
  },
  smallLabel: {
    fontSize: 11,
  },
});
