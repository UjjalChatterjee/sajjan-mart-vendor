import React from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity } from 'react-native';
import { Colors } from '../theme/colors';
import type { OrderItem } from '../types';

interface OrderItemRowProps {
  item: OrderItem;
  showDivider?: boolean;
  /** When true, show Ready/Cancel controls (only for confirmed orders) */
  showControls?: boolean;
  /** Callback when Ready is pressed */
  onReady?: (itemId: string) => void;
  /** Callback when Cancel is pressed */
  onCancel?: (itemId: string) => void;
  /** Whether a mutation is in-flight for this specific item */
  isProcessing?: boolean;
}

function formatCurrency(amount: number): string {
  return `₹${amount.toLocaleString('en-IN')}`;
}

export function OrderItemRow({
  item,
  showDivider = true,
  showControls = false,
  onReady,
  onCancel,
  isProcessing = false,
}: OrderItemRowProps) {
  // Item status derived EXCLUSIVELY from backend flags
  const isReady = item.ready === true;
  const isCancelled = item.cancelled === true;

  // CASE 4: both true → invalid state
  const isInvalid = isReady && isCancelled;

  return (
    <View style={[styles.row, showDivider && styles.divider]}>
      {item.image ? (
        <Image source={{ uri: item.image }} style={styles.itemImage} />
      ) : (
        <View style={styles.iconContainer}>
          <Text style={styles.iconEmoji}>📦</Text>
        </View>
      )}

      <View style={styles.details}>
        <Text style={styles.name} numberOfLines={1}>
          {item.name}
        </Text>
        {item.variantName ? (
          <Text style={styles.variant} numberOfLines={1}>
            {item.variantName}
          </Text>
        ) : null}
        <Text style={styles.qty}>
          {formatCurrency(item.price)} × {item.quantity}
          {item.unit ? ` / ${item.unit}` : ''}
        </Text>
      </View>

      <View style={styles.rightSection}>
        <Text style={styles.total}>{formatCurrency(item.total)}</Text>

        {/* CASE 4: ready + cancelled = invalid — always show */}
        {isInvalid && (
          <View style={[styles.statusBadge, styles.invalidBadge]}>
            <Text style={styles.invalidBadgeText}>Invalid status</Text>
          </View>
        )}

        {/* CASE 1: ready=true, cancelled=false → show Ready badge (always) */}
        {!isInvalid && isReady && !isCancelled && (
          <View style={styles.statusBadge}>
            <Text style={styles.readyBadgeText}>Ready</Text>
          </View>
        )}

        {/* CASE 2: ready=false, cancelled=true → show Cancelled badge (always) */}
        {!isInvalid && !isReady && isCancelled && (
          <View style={[styles.statusBadge, styles.cancelledBadge]}>
            <Text style={styles.cancelledBadgeText}>Cancelled</Text>
          </View>
        )}

        {/* CASE 3: ready=false, cancelled=false → show action buttons only when showControls */}
        {showControls && !isInvalid && !isReady && !isCancelled && (
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.readyBtn, isProcessing && styles.btnDisabled]}
              activeOpacity={isProcessing ? 1 : 0.7}
              disabled={isProcessing}
              onPress={() => onReady?.(item.id)}
            >
              <Text style={[styles.readyBtnText, isProcessing && styles.btnTextDisabled]}>
                Ready
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.cancelBtn, isProcessing && styles.cancelBtnDisabled]}
              activeOpacity={isProcessing ? 1 : 0.7}
              disabled={isProcessing}
              onPress={() => onCancel?.(item.id)}
            >
              <Text style={[styles.cancelBtnText, isProcessing && styles.cancelBtnTextDisabled]}>
                Cancel
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  itemImage: {
    width: 44,
    height: 44,
    borderRadius: 10,
    marginRight: 14,
    backgroundColor: Colors.primaryTintSoft,
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: Colors.primaryTintSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  iconEmoji: {
    fontSize: 20,
  },
  variant: {
    fontSize: 12,
    color: Colors.gray400,
    marginBottom: 2,
  },
  details: {
    flex: 1,
    marginRight: 12,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.gray800,
    marginBottom: 3,
  },
  qty: {
    fontSize: 13,
    color: Colors.gray500,
  },
  total: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.gray800,
    textAlign: 'right',
  },
  rightSection: {
    alignItems: 'flex-end',
    gap: 6,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 6,
  },
  readyBtn: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#F97316',
  },
  readyBtnText: {
    color: Colors.white,
    fontSize: 12,
    fontWeight: '700',
  },
  cancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: Colors.danger,
    backgroundColor: Colors.white,
  },
  cancelBtnText: {
    color: Colors.danger,
    fontSize: 12,
    fontWeight: '700',
  },
  btnDisabled: {
    backgroundColor: Colors.gray300,
  },
  btnTextDisabled: {
    color: Colors.white,
  },
  cancelBtnDisabled: {
    borderColor: Colors.gray300,
    backgroundColor: Colors.gray50,
  },
  cancelBtnTextDisabled: {
    color: Colors.gray400,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: Colors.successLight,
  },
  readyBadgeText: {
    color: Colors.successDark,
    fontSize: 11,
    fontWeight: '700',
  },
  cancelledBadge: {
    backgroundColor: Colors.dangerLight,
  },
  cancelledBadgeText: {
    color: Colors.dangerDark,
    fontSize: 11,
    fontWeight: '700',
  },
  invalidBadge: {
    backgroundColor: Colors.gray100,
  },
  invalidBadgeText: {
    color: Colors.gray500,
    fontSize: 11,
    fontWeight: '700',
  },
});
