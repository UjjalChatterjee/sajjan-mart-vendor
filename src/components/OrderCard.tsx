import React, { useState } from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { Colors } from '../theme/colors';
import { StatusBadge } from './StatusBadge';
import { OrderItemRow } from './OrderItemRow';
import type { Order } from '../types';

interface OrderCardProps {
  order: Order;
  onPress?: (orderId: string) => void;
  onAccept?: (orderId: string) => void;
  onReject?: (orderId: string) => void;
  isAccepting?: boolean;
  isRejecting?: boolean;
  onMarkDispatched?: (orderId: string) => void;
  isDispatching?: boolean;
  onItemReady?: (orderId: string, itemId: string) => void;
  onItemCancel?: (orderId: string, itemId: string) => void;
  processingItems?: Set<string>;
  onMarkDelivered?: (orderId: string) => void;
  isDelivering?: boolean;
}

/* ── Helpers ── */

function formatOrderTime(isoString: string): string {
  const orderDate = new Date(isoString);
  const now = new Date();
  const hours = orderDate.getHours();
  const minutes = orderDate.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const h = hours % 12 || 12;
  const time = `${h}:${minutes} ${ampm}`;

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const orderDayStart = new Date(
    orderDate.getFullYear(),
    orderDate.getMonth(),
    orderDate.getDate(),
  );
  const diffDays = Math.floor(
    (todayStart.getTime() - orderDayStart.getTime()) / 86400000,
  );

  if (diffDays === 0) return `Today, ${time}`;
  if (diffDays === 1) return `Yesterday, ${time}`;

  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${orderDate.getDate()} ${months[orderDate.getMonth()]}, ${time}`;
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

const COLLAPSED_COUNT = 2;

/* ── Component ── */

export function OrderCard({
  order,
  onPress,
  onAccept,
  onReject,
  isAccepting,
  isRejecting,
  onMarkDispatched,
  isDispatching = false,
  onItemReady,
  onItemCancel,
  processingItems,
  onMarkDelivered,
  isDelivering = false,
}: OrderCardProps) {
  const CardWrapper = onPress ? TouchableOpacity : View;
  const [expanded, setExpanded] = useState(false);

  const isConfirmed = order.status === 'confirmed';
  const totalCount = order.items.length;

  // Progress: count items where ready or cancelled (backend flags)
  const handledCount = order.items.filter(
    item => item.ready === true || item.cancelled === true,
  ).length;

  const isShipped = order.status === 'shipped';
  const isDelivered = order.status === 'delivered';

  // Show Mark Dispatched only for confirmed orders that aren't already shipped
  const showDispatch = isConfirmed && !isShipped;

  // NEW ORDER AMOUNT — only when original_total !== updated_total
  const originalTotalVal = order.amounts?.originalTotal ?? order.grandTotal;
  const updatedTotalVal = order.amounts?.updatedTotal ?? order.grandTotal;
  const hasAmountChange = originalTotalVal !== updatedTotalVal;

  // ── Confirmed order rendering ──
  if (isConfirmed) {
    return (
      <View style={styles.card}>
        {/* ── Header: Order number + Status badge ── */}
        <View style={styles.topRow}>
          <Text style={styles.orderId}>#{order.orderNumber || order.id}</Text>
          <StatusBadge status={order.status} size="small" />
        </View>

        {/* ── Meta: Date · items · customer · phone ── */}
        <Text style={styles.meta}>
          {formatDate(order.createdAt)} · {totalCount} item{totalCount !== 1 ? 's' : ''} · {order.customerName}{order.customerPhone ? ` · ${order.customerPhone}` : ''}
        </Text>

        {/* ── Amount + New Order Amount + Mark Dispatched ── */}
        <View style={styles.summaryRow}>
          {hasAmountChange ? (
            <View style={styles.newAmountBlock}>
              <Text style={styles.newAmountLabel}>NEW ORDER AMOUNT</Text>
              <Text style={styles.newAmountValue}>{formatCurrency(updatedTotalVal)}</Text>
              <Text style={styles.newAmountOld}>was {formatCurrency(originalTotalVal)}</Text>
            </View>
          ) : (
            <Text style={styles.amount}>{formatCurrency(order.grandTotal)}</Text>
          )}

          {showDispatch && (
            <TouchableOpacity
              style={[styles.dispatchBtn, isDispatching && styles.dispatchBtnDisabled]}
              activeOpacity={isDispatching ? 1 : 0.7}
              disabled={isDispatching}
              onPress={() => onMarkDispatched?.(order.id)}
            >
              <Text style={[styles.dispatchBtnText, isDispatching && styles.dispatchBtnTextDisabled]}>
                {isDispatching ? 'Dispatching…' : 'Mark Dispatched'}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Payment info row ── */}
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>
            PAYMENT: {order.paymentMethod ? order.paymentMethod.toUpperCase() : 'COD'}
          </Text>
          <Text style={styles.infoLabel}>
            Payment Status: {order.paymentStatus || 'Pending'}
          </Text>
        </View>

        {/* ── Progress ── */}
        <Text style={styles.progressText}>
          Progress: {handledCount} / {totalCount} items handled
        </Text>

        {/* ── Items ── */}
        <View style={styles.itemsSection}>
          {order.items.map((item, index) => (
            <OrderItemRow
              key={item.id}
              item={item}
              showDivider={index < order.items.length - 1}
              showControls
              onReady={(itemId) => onItemReady?.(order.id, itemId)}
              onCancel={(itemId) => onItemCancel?.(order.id, itemId)}
              isProcessing={processingItems?.has(item.id) ?? false}
            />
          ))}
        </View>

        {/* ── Price Summary ── */}
        <View style={styles.amountSection}>
          <View style={styles.amountRow}>
            <Text style={styles.amountLabel}>Subtotal</Text>
            <Text style={styles.amountValue}>
              {formatCurrency(order.amounts?.activeSubtotal ?? order.subtotal)}
            </Text>
          </View>
          <View style={styles.amountRow}>
            <Text style={styles.amountLabel}>Shipping</Text>
            <Text style={styles.amountValue}>{formatCurrency(order.amounts?.updatedShipping ?? order.deliveryCharge)}</Text>
          </View>
          <View style={styles.amountRow}>
            <Text style={styles.amountLabel}>Tax</Text>
            <Text style={styles.amountValue}>
              {formatCurrency(order.amounts?.updatedTax ?? order.tax)}
            </Text>
          </View>

          {order.amounts?.originalTotal != null && (
            <>
              <View style={styles.amountDivider} />
              <View style={styles.amountRow}>
                <Text style={styles.amountLabelBold}>Original total</Text>
                <Text style={styles.amountValueBold}>
                  {formatCurrency(order.amounts.originalTotal)}
                </Text>
              </View>
            </>
          )}
        </View>

        {/* ── Cancellation / Refund section ── */}
        {order.amounts?.hasCancellation && (
          <View style={styles.cancellationSection}>
            <Text style={styles.cancellationTitle}>CANCELLATION / REFUND</Text>

            {order.amounts.cancelledSubtotal != null && order.amounts.cancelledSubtotal > 0 && (
              <View style={styles.amountRow}>
                <Text style={styles.amountLabel}>Cancelled items</Text>
                <Text style={styles.amountLabelCancelValue}>
                  −{formatCurrency(order.amounts.cancelledSubtotal)}
                </Text>
              </View>
            )}

            {order.amounts.refundDueTotal != null && order.amounts.refundDueTotal > 0 && (
              <View style={styles.amountRow}>
                <Text style={styles.amountLabel}>Refund due</Text>
                <Text style={styles.amountLabelCancelValue}>
                  {formatCurrency(order.amounts.refundDueTotal)}
                </Text>
              </View>
            )}

            {order.amounts.refundPending && (
              <View style={styles.refundPendingBadge}>
                <Text style={styles.refundPendingText}>Refund pending</Text>
              </View>
            )}

            {order.amounts.codCollect != null && order.amounts.codCollect > 0 && (
              <View style={styles.amountRow}>
                <Text style={styles.amountLabel}>COD to collect</Text>
                <Text style={styles.amountValue}>
                  {formatCurrency(order.amounts.codCollect)}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* ── Delivery Address ── */}
        {order.address && (
          <View style={styles.addressSection}>
            <Text style={styles.addressTitle}>Delivery address</Text>
            {(order.address.fullName || order.address.phone) && (
              <Text style={styles.addressLine}>
                {[order.address.fullName, order.address.phone].filter(Boolean).join(' · ')}
              </Text>
            )}
            {(() => {
              const parts = [order.address.line1, order.address.line2, order.address.city, order.address.state]
                .filter(Boolean)
                .map(String);
              const pincode = order.address.pincode ? ` - ${order.address.pincode}` : '';
              if (parts.length === 0 && !pincode) return null;
              return (
                <Text style={styles.addressLine}>
                  {parts.join(', ')}{pincode}
                </Text>
              );
            })()}
          </View>
        )}
      </View>
    );
  }

  // ── Shipped order rendering ──
  if (isShipped) {
    const isCOD = order.paymentMethod === 'cod';
    const amountToCollect =
      order.amounts?.codCollect ??
      order.amounts?.updatedTotal ??
      order.amounts?.originalTotal ??
      order.grandTotal;

    return (
      <View style={styles.card}>
        {/* ── Header: Order number + Status badge + Amount ── */}
        <View style={styles.topRow}>
          <Text style={styles.orderId}>#{order.orderNumber || order.id}</Text>
          <StatusBadge status={order.status} size="small" />
        </View>

        {/* ── Meta: Date · items · customer · phone ── */}
        <Text style={styles.meta}>
          {formatDate(order.createdAt)} · {totalCount} item{totalCount !== 1 ? 's' : ''} · {order.customerName}{order.customerPhone ? ` · ${order.customerPhone}` : ''}
        </Text>

        {/* ── Amount + Mark Delivered ── */}
        <View style={styles.summaryRow}>
          {hasAmountChange ? (
            <View style={styles.newAmountBlock}>
              <Text style={styles.newAmountLabel}>NEW ORDER AMOUNT</Text>
              <Text style={styles.newAmountValue}>{formatCurrency(updatedTotalVal)}</Text>
              <Text style={styles.newAmountOld}>was {formatCurrency(originalTotalVal)}</Text>
            </View>
          ) : (
            <Text style={styles.amount}>{formatCurrency(order.grandTotal)}</Text>
          )}

          <TouchableOpacity
            style={[styles.dispatchBtn, isDelivering && styles.dispatchBtnDisabled]}
            activeOpacity={isDelivering ? 1 : 0.7}
            disabled={isDelivering}
            onPress={() => onMarkDelivered?.(order.id)}
          >
            <Text style={[styles.dispatchBtnText, isDelivering && styles.dispatchBtnTextDisabled]}>
              {isDelivering ? 'Delivering…' : 'Mark Delivered'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── Payment info row ── */}
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>
            PAYMENT: {order.paymentMethod ? order.paymentMethod.toUpperCase() : 'COD'}
          </Text>
          <Text style={styles.infoLabel}>
            Payment Status: {order.paymentStatus || 'Pending'}
          </Text>
        </View>

        {/* ── AMOUNT TO COLLECT (COD only) ── */}
        {isCOD && (
          <View style={styles.collectSection}>
            <View style={styles.collectTopRow}>
              <Text style={styles.collectTitle}>AMOUNT TO COLLECT</Text>
              <View style={styles.collectBadge}>
                <Text style={styles.collectBadgeText}>COD · {(order.paymentStatus || 'PENDING').toUpperCase()}</Text>
              </View>
            </View>
            <View style={styles.collectBottomRow}>
              <Text style={styles.collectAmount}>{formatCurrency(amountToCollect)}</Text>
              <Text style={styles.collectHint}>Collect cash at delivery</Text>
            </View>
          </View>
        )}

        {/* ── Items (no Ready/Cancel buttons for shipped) ── */}
        <View style={styles.itemsSection}>
          {order.items.map((item, index) => (
            <OrderItemRow
              key={item.id}
              item={item}
              showDivider={index < order.items.length - 1}
            />
          ))}
        </View>

        {/* ── Price Summary ── */}
        <View style={styles.amountSection}>
          <View style={styles.amountRow}>
            <Text style={styles.amountLabel}>Subtotal</Text>
            <Text style={styles.amountValue}>
              {formatCurrency(order.amounts?.activeSubtotal ?? order.subtotal)}
            </Text>
          </View>
          <View style={styles.amountRow}>
            <Text style={styles.amountLabel}>Shipping</Text>
            <Text style={styles.amountValue}>{formatCurrency(order.amounts?.updatedShipping ?? order.deliveryCharge)}</Text>
          </View>
          <View style={styles.amountRow}>
            <Text style={styles.amountLabel}>Tax</Text>
            <Text style={styles.amountValue}>
              {formatCurrency(order.amounts?.updatedTax ?? order.tax)}
            </Text>
          </View>

          {order.amounts?.originalTotal != null && (
            <>
              <View style={styles.amountDivider} />
              <View style={styles.amountRow}>
                <Text style={styles.amountLabelBold}>Original total</Text>
                <Text style={styles.amountValueBold}>
                  {formatCurrency(order.amounts.originalTotal)}
                </Text>
              </View>
            </>
          )}
        </View>

        {/* ── Delivery Address ── */}
        {order.address && (
          <View style={styles.addressSection}>
            <Text style={styles.addressTitle}>Delivery address</Text>
            {(order.address.fullName || order.address.phone) && (
              <Text style={styles.addressLine}>
                {[order.address.fullName, order.address.phone].filter(Boolean).join(' · ')}
              </Text>
            )}
            {(() => {
              const parts = [order.address.line1, order.address.line2, order.address.city, order.address.state]
                .filter(Boolean)
                .map(String);
              const pincode = order.address.pincode ? ` - ${order.address.pincode}` : '';
              if (parts.length === 0 && !pincode) return null;
              return (
                <Text style={styles.addressLine}>
                  {parts.join(', ')}{pincode}
                </Text>
              );
            })()}
          </View>
        )}
      </View>
    );
  }

  // ── Delivered / Completed order rendering ──
  if (isDelivered) {
    const cancelledItems = order.items.filter(item => item.cancelled === true);
    const collectAmount =
      order.amounts?.codCollect ??
      order.amounts?.updatedTotal ??
      order.amounts?.originalTotal ??
      order.grandTotal;

    return (
      <View style={styles.card}>
        {/* ── Header: Order number + Status badge ── */}
        <View style={styles.topRow}>
          <Text style={styles.orderId}>#{order.orderNumber || order.id}</Text>
          <StatusBadge status={order.status} size="small" />
        </View>

        {/* ── Meta: Date · items · customer · phone ── */}
        <Text style={styles.meta}>
          {formatDate(order.createdAt)} · {totalCount} item{totalCount !== 1 ? 's' : ''} · {order.customerName}{order.customerPhone ? ` · ${order.customerPhone}` : ''}
        </Text>

        {/* ── Amount (or NEW ORDER AMOUNT) ── */}
        <View style={styles.summaryRow}>
          {hasAmountChange ? (
            <View style={styles.newAmountBlock}>
              <Text style={styles.newAmountLabel}>NEW ORDER AMOUNT</Text>
              <Text style={styles.newAmountValue}>{formatCurrency(updatedTotalVal)}</Text>
              <Text style={styles.newAmountOld}>was {formatCurrency(originalTotalVal)}</Text>
            </View>
          ) : (
            <Text style={styles.amount}>{formatCurrency(order.grandTotal)}</Text>
          )}
        </View>

        {/* ── Payment info row ── */}
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>
            PAYMENT: {order.paymentMethod ? order.paymentMethod.toUpperCase() : 'COD'}
          </Text>
          <Text style={styles.infoLabel}>
            Payment Status: {order.paymentStatus || 'Pending'}
          </Text>
        </View>

        {/* ── Items (no action buttons for delivered) ── */}
        <View style={styles.itemsSection}>
          {order.items.map((item, index) => (
            <OrderItemRow
              key={item.id}
              item={item}
              showDivider={index < order.items.length - 1}
            />
          ))}
        </View>

        {/* ── Price Summary ── */}
        <View style={styles.amountSection}>
          <View style={styles.amountRow}>
            <Text style={styles.amountLabel}>Subtotal</Text>
            <Text style={styles.amountValue}>
              {formatCurrency(order.amounts?.activeSubtotal ?? order.subtotal)}
            </Text>
          </View>
          <View style={styles.amountRow}>
            <Text style={styles.amountLabel}>Shipping</Text>
            <Text style={styles.amountValue}>{formatCurrency(order.amounts?.updatedShipping ?? order.deliveryCharge)}</Text>
          </View>
          <View style={styles.amountRow}>
            <Text style={styles.amountLabel}>Tax</Text>
            <Text style={styles.amountValue}>
              {formatCurrency(order.amounts?.updatedTax ?? order.tax)}
            </Text>
          </View>

          {order.amounts?.originalTotal != null && (
            <>
              <View style={styles.amountDivider} />
              <View style={styles.amountRow}>
                <Text style={styles.amountLabelBold}>Original total</Text>
                <Text style={styles.amountValueBold}>
                  {formatCurrency(order.amounts.originalTotal)}
                </Text>
              </View>
            </>
          )}
        </View>

        {/* ── Cancellation / Refund section (per-item rows) ── */}
        {cancelledItems.length > 0 && (
          <View style={styles.cancellationSection}>
            <Text style={styles.cancellationTitle}>CANCELLATION / REFUND</Text>

            {cancelledItems.map(item => (
              <View key={item.id} style={styles.amountRow}>
                <Text style={styles.cancelItemLabel}>Cancelled · {item.name}</Text>
                <Text style={styles.amountLabelCancelValue}>
                  −{formatCurrency(item.total)}
                </Text>
              </View>
            ))}

            {order.amounts?.originalTotal != null && (
              <View style={styles.amountRow}>
                <Text style={styles.amountLabel}>Original order value</Text>
                <Text style={styles.amountValueBold}>
                  {formatCurrency(order.amounts.originalTotal)}
                </Text>
              </View>
            )}

            {order.amounts?.updatedTotal != null && (
              <View style={styles.amountRow}>
                <Text style={styles.amountLabel}>Updated order value</Text>
                <Text style={styles.amountValueBold}>
                  {formatCurrency(order.amounts.updatedTotal)}
                </Text>
              </View>
            )}

            <View style={[styles.amountRow, { marginTop: 4 }] }>
              <Text style={[styles.amountLabel, { fontWeight: '700', color: Colors.gray800 }]}>Collect from customer</Text>
              <Text style={[styles.amountValueBold, { color: Colors.primary }]}>
                {formatCurrency(collectAmount)}
              </Text>
            </View>
          </View>
        )}

        {/* ── Delivery Address ── */}
        {order.address && (
          <View style={styles.addressSection}>
            <Text style={styles.addressTitle}>Delivery address</Text>
            {(order.address.fullName || order.address.phone) && (
              <Text style={styles.addressLine}>
                {[order.address.fullName, order.address.phone].filter(Boolean).join(' · ')}
              </Text>
            )}
            {(() => {
              const parts = [order.address.line1, order.address.line2, order.address.city, order.address.state]
                .filter(Boolean)
                .map(String);
              const pincode = order.address.pincode ? ` - ${order.address.pincode}` : '';
              if (parts.length === 0 && !pincode) return null;
              return (
                <Text style={styles.addressLine}>
                  {parts.join(', ')}{pincode}
                </Text>
              );
            })()}
          </View>
        )}
      </View>
    );
  }

  // ── Non-confirmed orders: existing UI ──
  const hasMore = totalCount > COLLAPSED_COUNT;
  const remainingCount = totalCount - COLLAPSED_COUNT;
  const visibleItems = expanded
    ? order.items
    : order.items.slice(0, COLLAPSED_COUNT);

  return (
    <CardWrapper
      {...(onPress ? { activeOpacity: 0.7, onPress: () => onPress(order.id) } : {})}
      style={styles.card}
    >
      {/* Top row — Order ID + Status */}
      <View style={styles.topRow}>
        <Text style={styles.orderId}>#{order.orderNumber || order.id}</Text>
        <StatusBadge status={order.status} size="small" />
      </View>

      {/* Customer */}
      <Text style={styles.customerName}>{order.customerName}</Text>
      <Text style={styles.meta}>
        {totalCount} item{totalCount !== 1 ? 's' : ''}
      </Text>

      {/* Amount + Time */}
      <View style={styles.summaryRow}>
        <Text style={styles.amount}>{formatCurrency(order.grandTotal)}</Text>
        <Text style={styles.time}>{formatOrderTime(order.createdAt)}</Text>
      </View>

      {/* Payment info */}
      {order.paymentMethod && (
        <View style={styles.paymentRow}>
          <Text style={styles.paymentMethod}>
            {order.paymentMethod.toUpperCase()}
          </Text>
        </View>
      )}

      {/* Order items */}
      {hasMore ? (
        <View style={styles.itemsSection}>
          {visibleItems.map((item, index) => (
            <OrderItemRow
              key={item.id}
              item={item}
              showDivider={index < visibleItems.length - 1 || (expanded && remainingCount > 0)}
            />
          ))}
          <TouchableOpacity
            style={styles.moreToggle}
            activeOpacity={0.6}
            onPress={() => setExpanded(prev => !prev)}
          >
            <Text style={styles.moreToggleLabel}>
              {expanded ? 'Show less' : `+${remainingCount} more`}
            </Text>
            <Text style={styles.chevron}>{expanded ? '▲' : '▼'}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        visibleItems.map((item, index) => (
          <OrderItemRow
            key={item.id}
            item={item}
            showDivider={index < visibleItems.length - 1}
          />
        ))
      )}

      {/* Amount Summary */}
      <View style={styles.amountSection}>
        <View style={styles.amountRow}>
          <Text style={styles.amountLabel}>Subtotal</Text>
          <Text style={styles.amountValue}>{formatCurrency(order.subtotal)}</Text>
        </View>
        <View style={styles.amountRow}>
          <Text style={styles.amountLabel}>Shipping</Text>
          <Text style={styles.amountValue}>{formatCurrency(order.deliveryCharge)}</Text>
        </View>
        <View style={styles.amountRow}>
          <Text style={styles.amountLabel}>Tax</Text>
          <Text style={styles.amountValue}>{formatCurrency(order.tax)}</Text>
        </View>
        {order.amounts?.originalTotal != null && (
          <>
            <View style={styles.amountDivider} />
            <View style={styles.amountRow}>
              <Text style={styles.amountLabelBold}>Original total</Text>
              <Text style={styles.amountValueBold}>{formatCurrency(order.amounts.originalTotal)}</Text>
            </View>
          </>
        )}
      </View>

      {/* Delivery Address */}
      {order.address && (
        <View style={styles.addressSection}>
          <Text style={styles.addressTitle}>Delivery address</Text>
          {(order.address.fullName || order.address.phone) && (
            <Text style={styles.addressLine}>
              {[order.address.fullName, order.address.phone].filter(Boolean).join(' · ')}
            </Text>
          )}
          {(() => {
            const parts = [order.address.line1, order.address.line2, order.address.city, order.address.state]
              .filter(Boolean)
              .map(String);
            const pincode = order.address.pincode ? ` - ${order.address.pincode}` : '';
            if (parts.length === 0 && !pincode) return null;
            return (
              <Text style={styles.addressLine}>
                {parts.join(', ')}{pincode}
              </Text>
            );
          })()}
        </View>
      )}

      {/* Accept / Reject — only for pending orders */}
      {order.status === 'pending' && (onAccept || onReject) && (
        <View style={styles.actionRow}>
          {onAccept && (
            <TouchableOpacity
              style={[styles.acceptBtn, isAccepting && styles.acceptBtnDisabled]}
              activeOpacity={isAccepting ? 1 : 0.7}
              disabled={isAccepting}
              onPress={() => onAccept(order.id)}>
              <Text style={[styles.acceptBtnText, isAccepting && styles.acceptBtnTextDisabled]}>
                {isAccepting ? 'Accepting…' : 'Accept'}
              </Text>
            </TouchableOpacity>
          )}
          {onReject && (
            <TouchableOpacity
              style={[styles.rejectBtn, isRejecting && styles.rejectBtnDisabled]}
              activeOpacity={isRejecting ? 1 : 0.7}
              disabled={isRejecting}
              onPress={() => onReject(order.id)}>
              <Text style={[styles.rejectBtnText, isRejecting && styles.rejectBtnTextDisabled]}>
                {isRejecting ? 'Rejecting…' : 'Reject'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </CardWrapper>
  );
}

/* ── Styles ── */

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

  /* ── Header ── */
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
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
    marginBottom: 2,
  },
  meta: {
    fontSize: 13,
    color: Colors.gray500,
    marginBottom: 10,
    lineHeight: 18,
  },

  /* ── Summary row ── */
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  amount: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.primary,
  },
  time: {
    fontSize: 13,
    color: Colors.gray500,
  },

  /* ── Info / progress ── */
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  infoLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.gray500,
    letterSpacing: 0.3,
  },
  progressText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.gray700,
    marginBottom: 8,
  },

  /* ── Payment (non-confirmed) ── */
  paymentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  },
  paymentMethod: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.gray500,
    letterSpacing: 0.5,
  },

  newAmountBlock: {
    alignItems: 'flex-end',
  },
  newAmountLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: Colors.gray500,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  newAmountValue: {
    fontSize: 17,
    fontWeight: '800',
    color: Colors.danger,
  },
  newAmountOld: {
    fontSize: 12,
    color: Colors.gray400,
    textDecorationLine: 'line-through',
    marginTop: 1,
  },

  /* ── Amount to Collect (shipped COD) ── */
  collectSection: {
    marginTop: 10,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#FEF9EE',
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  collectTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  collectTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.gray600,
    letterSpacing: 0.5,
  },
  collectBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#FEF3C7',
  },
  collectBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: Colors.warning,
    letterSpacing: 0.3,
  },
  collectBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  collectAmount: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.gray900,
  },
  collectHint: {
    fontSize: 12,
    color: Colors.gray400,
  },

  /* ── Mark Dispatched button ── */
  dispatchBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#F97316',
  },
  dispatchBtnDisabled: {
    backgroundColor: Colors.gray300,
  },
  dispatchBtnText: {
    color: Colors.white,
    fontSize: 13,
    fontWeight: '700',
  },
  dispatchBtnTextDisabled: {
    color: Colors.white,
  },

  /* ── Items section ── */
  itemsSection: {
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingTop: 4,
    marginTop: 4,
  },
  moreToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
  },
  moreToggleLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.primary,
  },
  chevron: {
    fontSize: 11,
    color: Colors.primary,
  },

  /* ── Amount Summary ── */
  amountSection: {
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingTop: 12,
    marginTop: 8,
    gap: 6,
  },
  amountRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  amountLabel: {
    fontSize: 13,
    color: Colors.gray500,
  },
  amountValue: {
    fontSize: 13,
    color: Colors.gray700,
  },
  amountDivider: {
    height: 1,
    backgroundColor: '#F3F4F6',
    marginVertical: 4,
  },
  amountLabelBold: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.gray800,
  },
  amountValueBold: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.gray900,
  },

  /* ── Cancellation / Refund ── */
  cancellationSection: {
    borderTopWidth: 1,
    borderTopColor: '#FEE2E2',
    paddingTop: 12,
    marginTop: 10,
    gap: 6,
    backgroundColor: '#FFFBFB',
    borderRadius: 10,
    padding: 12,
  },
  cancellationTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.danger,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  cancelItemLabel: {
    fontSize: 12,
    color: Colors.danger,
    flex: 1,
  },
  amountLabelCancelValue: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.danger,
  },
  refundPendingBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: Colors.warningLight,
    marginTop: 2,
  },
  refundPendingText: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.warning,
  },

  /* ── Delivery Address ── */
  addressSection: {
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingTop: 12,
    marginTop: 10,
  },
  addressTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.gray500,
    marginBottom: 4,
  },
  addressLine: {
    fontSize: 13,
    color: Colors.gray700,
    lineHeight: 19,
  },

  /* ── Accept / Reject buttons ── */
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  acceptBtn: {
    flex: 1,
    height: 42,
    borderRadius: 10,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acceptBtnDisabled: {
    backgroundColor: Colors.gray300,
  },
  acceptBtnText: {
    color: Colors.white,
    fontSize: 14,
    fontWeight: '700',
  },
  acceptBtnTextDisabled: {
    color: Colors.white,
  },
  rejectBtn: {
    flex: 1,
    height: 42,
    borderRadius: 10,
    backgroundColor: Colors.white,
    borderWidth: 1.5,
    borderColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectBtnDisabled: {
    backgroundColor: Colors.gray100,
    borderColor: Colors.gray300,
  },
  rejectBtnText: {
    color: Colors.danger,
    fontSize: 14,
    fontWeight: '700',
  },
  rejectBtnTextDisabled: {
    color: Colors.gray400,
  },
});
