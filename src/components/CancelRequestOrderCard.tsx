import React, { useState, useCallback } from 'react';
import { useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Colors } from '../theme/colors';
import { StatusBadge } from './StatusBadge';
import type { Order } from '../types';

interface CancelRequestOrderCardProps {
  order: Order;
  onApproveItem: (orderId: string, itemId: string) => Promise<void>;
  onRejectItem: (orderId: string, itemId: string) => Promise<void>;
  onApproveSelected: (orderId: string, itemIds: string[]) => Promise<void>;
  onRejectSelected: (orderId: string, itemIds: string[]) => Promise<void>;
  queryClient: {
    invalidateQueries: (opts: { queryKey: string[] }) => Promise<unknown>;
  };
  showSuccess: (message: string, duration?: number) => void;
  showError: (message: string, duration?: number) => void;
}

function formatCurrency(amount: number): string {
  return `₹${amount.toLocaleString('en-IN')}`;
}

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${d.getDate()} ${months[d.getMonth()]}, ${d.getFullYear()}`;
}

/** Action keys for per-item/submit loading states. */
function submittingKey(orderId: string, kind: 'approve' | 'reject', itemIds?: string[]): string {
  const normalized = itemIds?.map(id => String(id)).sort().join(',') ?? '';
  return `${orderId}:${kind}:${normalized}`;
}

export function CancelRequestOrderCard(props: CancelRequestOrderCardProps) {
  const {
    order,
    onApproveItem,
    onRejectItem,
    onApproveSelected,
    onRejectSelected,
    queryClient,
    showSuccess,
    showError,
  } = props;

  const itemSubmitting = React.useState<Set<string>>(new Set())[0];
  const setItemSubmitting = React.useState<Set<string>>(new Set())[1];

  const [selectedItemIds, setSelectedItemIds] = useState<string[]>(() => {
    if (order.status === 'cancel_request' && Array.isArray(order.cancel_request_items)) {
      return order.cancel_request_items.map(String);
    }
    return [];
  });

  const selectedSet = new Set(selectedItemIds.map(String));

  const toggleItem = useCallback(
    (itemId: string) => {
      setSelectedItemIds(prev =>
        prev.includes(itemId)
          ? prev.filter(id => id !== itemId)
          : [...prev, itemId],
      );
    },
    [],
  );

  const isItemSubmitting = useCallback(
    (key: string) => itemSubmitting.has(key),
    [itemSubmitting],
  );

  const approveSelected = useCallback(async () => {
    const ids = selectedItemIds.filter(Boolean);
    if (ids.length === 0) return;
    const key = submittingKey(order.id, 'approve', ids);
    if (isItemSubmitting(key)) return;

    setItemSubmitting(prev => new Set(prev).add(key));
    try {
      await onApproveSelected(order.id, ids);
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      showSuccess(`Approved ${ids.length} item(s) for refund`);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to approve selected items');
    } finally {
      setItemSubmitting(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [order.id, selectedItemIds, onApproveSelected, queryClient, showSuccess, showError, isItemSubmitting, setItemSubmitting]);

  const rejectSelected = useCallback(async () => {
    const ids = selectedItemIds.filter(Boolean);
    if (ids.length === 0) return;
    const key = submittingKey(order.id, 'reject', ids);
    if (isItemSubmitting(key)) return;

    setItemSubmitting(prev => new Set(prev).add(key));
    try {
      await onRejectSelected(order.id, ids);
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      showSuccess('Rejected selected cancellation requests');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to reject selected items');
    } finally {
      setItemSubmitting(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [order.id, selectedItemIds, onRejectSelected, queryClient, showSuccess, showError, isItemSubmitting, setItemSubmitting]);

  const totalSelected = selectedItemIds.length;
  const hasSelection = totalSelected > 0;

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.topRow}>
        <Text style={styles.orderId}>#{order.orderNumber || order.id}</Text>
        <StatusBadge status={order.status} size="small" />
      </View>

      <Text style={styles.meta}>
        {formatDate(order.createdAt)} · {order.items.length} item{order.items.length !== 1 ? 's' : ''}
      </Text>

      <Text style={styles.customerName}>{order.customerName}</Text>
      {order.customerPhone ? (
        <Text style={styles.meta}>📞 {order.customerPhone}</Text>
      ) : null}

      {order.address && (
        <View style={styles.addressSection}>
          <Text style={styles.addressTitle}>Delivery address</Text>
          {(() => {
            const addr = order.address;
            const parts = [
              addr.line1,
              addr.line2,
              addr.city,
              addr.state,
            ]
              .filter(Boolean)
              .map(String);
            const pincode = addr.pincode ? ` - ${String(addr.pincode)}` : '';
            const contact = [addr.fullName, addr.phone].filter(Boolean).join(' · ');
            return (
              <>
                {contact ? <Text style={styles.addressLine}>{contact}</Text> : null}
                {parts.length > 0 || pincode ? (
                  <Text style={styles.addressLine}>
                    {parts.join(', ')}{pincode}
                  </Text>
                ) : null}
              </>
            );
          })()}
        </View>
      )}

      {/* Summary amount */}
      <View style={styles.summaryRow}>
        <Text style={styles.amount}>{formatCurrency(order.grandTotal)}</Text>
        {order.paymentMethod && (
          <View style={styles.paymentRow}>
            <Text style={styles.paymentMethod}>
              {order.paymentMethod.toUpperCase()}
              {order.paymentStatus ? ` · ${order.paymentStatus}` : ''}
            </Text>
          </View>
        )}
      </View>

      {/* Items with checkboxes */}
      <View style={styles.itemsSection}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>
            Items ({order.items.length})
          </Text>
          <Text style={styles.selectedCount}>
            {totalSelected} item{totalSelected !== 1 ? 's' : ''} selected
            {totalSelected > 0 ? ' for refund' : ''}
          </Text>
        </View>

        {order.items.map((item, index) => {
          const checked = selectedSet.has(item.id);
          const itemSubmittingEither =
            isItemSubmitting(submittingKey(order.id, 'approve', [item.id])) ||
            isItemSubmitting(submittingKey(order.id, 'reject', [item.id]));

          const handleApproveItem = async () => {
            const key = submittingKey(order.id, 'approve', [item.id]);
            if (isItemSubmitting(key)) return;
            setItemSubmitting(prev => new Set(prev).add(key));
            try {
              await onApproveItem(order.id, item.id);
              await queryClient.invalidateQueries({ queryKey: ['orders'] });
              showSuccess('Item approved for refund');
            } catch (err) {
              showError(err instanceof Error ? err.message : 'Failed to approve item for refund');
            } finally {
              setItemSubmitting(prev => {
                const next = new Set(prev);
                next.delete(key);
                return next;
              });
            }
          };

          const handleRejectItem = async () => {
            const key = submittingKey(order.id, 'reject', [item.id]);
            if (isItemSubmitting(key)) return;
            setItemSubmitting(prev => new Set(prev).add(key));
            try {
              await onRejectItem(order.id, item.id);
              await queryClient.invalidateQueries({ queryKey: ['orders'] });
              showSuccess('Item cancellation request rejected');
            } catch (err) {
              showError(err instanceof Error ? err.message : 'Failed to reject item cancellation');
            } finally {
              setItemSubmitting(prev => {
                const next = new Set(prev);
                next.delete(key);
                return next;
              });
            }
          };

          return (
            <View key={item.id} style={[styles.itemRow, index < order.items.length - 1 && styles.itemDivider]}>
              <TouchableOpacity
                style={[styles.checkbox, checked && styles.checkboxChecked]}
                onPress={() => toggleItem(item.id)}
                activeOpacity={0.6}
              >
                {checked && <Text style={styles.checkmark}>✓</Text>}
              </TouchableOpacity>

              <View style={styles.itemDetails}>
                <Text style={styles.itemName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.itemQty}>
                  × {item.quantity}
                  {item.variantName ? ` · ${item.variantName}` : ''}
                </Text>
              </View>

              <View style={styles.itemRight}>
                <Text style={styles.itemTotal}>{formatCurrency(item.total)}</Text>

                {!itemSubmittingEither ? (
                  <View style={styles.itemActions}>
                    <TouchableOpacity
                      style={styles.itemApproveBtn}
                      onPress={handleApproveItem}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.itemApproveText}>Approve</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.itemRejectBtn}
                      onPress={handleRejectItem}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.itemRejectText}>Reject</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <Text style={styles.itemProcessing}>Processing…</Text>
                )}
              </View>
            </View>
          );
        })}
      </View>

      {/* Bulk actions */}
      <View style={styles.bulkActions}>
        <TouchableOpacity
          style={[styles.bulkBtn, styles.approveBtn, !hasSelection && styles.bulkBtnDisabled]}
          disabled={!hasSelection || isItemSubmitting(submittingKey(order.id, 'approve'))}
          activeOpacity={hasSelection ? 0.7 : 1}
          onPress={approveSelected}
        >
          <Text
            style={[
              styles.bulkBtnText,
              !hasSelection && styles.bulkBtnTextDisabled,
            ]}
          >
            Approve selected
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.bulkBtn, styles.rejectBtn, !hasSelection && styles.bulkBtnDisabled]}
          disabled={!hasSelection || isItemSubmitting(submittingKey(order.id, 'reject'))}
          activeOpacity={hasSelection ? 0.7 : 1}
          onPress={rejectSelected}
        >
          <Text
            style={[
              styles.bulkBtnText,
              styles.bulkRejectText,
              !hasSelection && styles.bulkBtnTextDisabled,
            ]}
          >
            Reject selected
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 18,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },

  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  orderId: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.gray800,
  },
  customerName: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.gray900,
    marginTop: 2,
    marginBottom: 2,
  },
  meta: {
    fontSize: 13,
    color: Colors.gray500,
    marginBottom: 2,
  },

  addressSection: {
    marginTop: 8,
    marginBottom: 10,
  },
  addressTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.gray500,
    marginBottom: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  addressLine: {
    fontSize: 13,
    color: Colors.gray600,
    lineHeight: 18,
  },

  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  amount: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.primary,
  },
  paymentRow: {
    alignItems: 'flex-end',
  },
  paymentMethod: {
    fontSize: 12,
    color: Colors.gray500,
    textAlign: 'right',
  },

  itemsSection: {
    marginBottom: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.gray500,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  selectedCount: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.primary,
  },

  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  itemDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F3F4F6',
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: Colors.gray400,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    backgroundColor: Colors.white,
  },
  checkboxChecked: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  checkmark: {
    color: Colors.white,
    fontSize: 13,
    fontWeight: '700',
  },
  itemDetails: {
    flex: 1,
    marginRight: 8,
  },
  itemName: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.gray800,
    marginBottom: 1,
  },
  itemQty: {
    fontSize: 12,
    color: Colors.gray500,
  },
  itemRight: {
    alignItems: 'flex-end',
    gap: 8,
  },
  itemTotal: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.gray800,
  },
  itemActions: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  itemApproveBtn: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: Colors.successLight,
  },
  itemApproveText: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.successDark,
  },
  itemRejectBtn: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.danger,
  },
  itemRejectText: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.danger,
  },
  itemProcessing: {
    fontSize: 11,
    color: Colors.gray500,
    marginTop: 4,
  },

  bulkActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  bulkBtn: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approveBtn: {
    backgroundColor: Colors.success,
  },
  rejectBtn: {
    backgroundColor: Colors.white,
    borderWidth: 1.5,
    borderColor: Colors.danger,
  },
  bulkBtnDisabled: {
    backgroundColor: Colors.gray100,
    borderColor: Colors.gray300,
  },
  bulkBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.white,
  },
  bulkRejectText: {
    color: Colors.danger,
  },
  bulkBtnTextDisabled: {
    color: Colors.gray400,
  },
});
