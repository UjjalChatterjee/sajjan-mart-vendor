import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Animated,
  Dimensions,
  Pressable,
  ScrollView,
} from 'react-native';
import { Colors } from '../theme/colors';
import type { Order } from '../types';
import { PREP_DEFAULT_MINUTES, isFoodOrder } from '../services/prepTimer';
import { MakingTimeStepper } from './MakingTimeStepper';
import {
  startOrderAlertSound,
  stopOrderAlertSound,
} from '../services/sound.service';

/* ──────────────────────────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────────────────────────── */

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const h = hours % 12 || 12;
  return `${h}:${minutes} ${ampm}`;
}

function formatCurrency(amount: number): string {
  return `₹${amount.toLocaleString('en-IN')}`;
}

/* ──────────────────────────────────────────────────────────────────────
 * Pulsing order icon — the header's attention cue
 * ────────────────────────────────────────────────────────────────────── */

function PulsingIcon() {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.12,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [pulseAnim]);

  return (
    <View style={s.iconOuter}>
      <Animated.View
        style={[s.pulseRing, { transform: [{ scale: pulseAnim }] }]}
      />
      <View style={s.iconInner}>
        <Text style={s.iconEmoji}>🛒</Text>
      </View>
    </View>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * NEW ORDER label with attention animation
 * ────────────────────────────────────────────────────────────────────── */

function AnimatedLabel() {
  const opacityAnim = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    const attention = Animated.loop(
      Animated.sequence([
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0.65,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    );
    attention.start();
    return () => attention.stop();
  }, [opacityAnim]);

  return (
    <Animated.Text style={[s.label, { opacity: opacityAnim }]}>
      NEW ORDER
    </Animated.Text>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Props
 * ────────────────────────────────────────────────────────────────────── */

interface NewOrderAlertModalProps {
  visible: boolean;
  order: Order | null;
  /**
   * `preparationMinutes` is sent only for a food order; it is undefined for
   * every other order so the accept request never carries a timer the backend
   * would have to discard.
   */
  onAccept: (orderId: string, preparationMinutes?: number) => void;
  onReject: (orderId: string) => void;
}

/* ──────────────────────────────────────────────────────────────────────
 * NewOrderAlertModal
 *
 * The popup shown by a NEW_ORDER push. OrderCard in the New Order tab offers
 * the same two decisions for the same order, so both carry the Making Time
 * stepper and both funnel into one settleDecision path in OrdersScreen.
 * Cannot be dismissed by tapping outside, swiping, or auto-timer.
 *
 * Three zones: a fixed header, a scrollable body (customer, items, amount),
 * and a fixed footer (Making Time + the two decisions) so the vendor can
 * always reach the controls on a small screen.
 * ────────────────────────────────────────────────────────────────────── */

export function NewOrderAlertModal({
  visible,
  order,
  onAccept,
  onReject,
}: NewOrderAlertModalProps) {
  const overlayAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.95)).current;
  const [preparationMinutes, setPreparationMinutes] = useState(
    PREP_DEFAULT_MINUTES,
  );

  useEffect(() => {
    if (visible) {
      if (order) {
        startOrderAlertSound({
          orderId: order.id,
          customerName: order.customerName,
          itemCount: String(order.items.length),
          total: String(order.grandTotal),
        });
      }
      Animated.parallel([
        Animated.timing(overlayAnim, {
          toValue: 1,
          duration: 280,
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 70,
          friction: 11,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      overlayAnim.setValue(0);
      scaleAnim.setValue(0.95);
    }
  }, [visible, overlayAnim, scaleAnim]);

  // Every order the vendor is shown starts at the default — including a second
  // NEW_ORDER that replaces the first while the popup never closed, which is
  // why the order id is part of the key and not just the visibility.
  useEffect(() => {
    if (visible) setPreparationMinutes(PREP_DEFAULT_MINUTES);
  }, [visible, order?.id]);

  if (!order) return null;

  const isFood = isFoodOrder(order);

  const handleAccept = () => {
    stopOrderAlertSound();
    onAccept(order.id, isFood ? preparationMinutes : undefined);
  };

  const handleReject = () => {
    stopOrderAlertSound();
    onReject(order.id);
  };

  // One badge per part that exists: a method without a status is not a gap.
  const paymentBadges: string[] = [];
  if (order.paymentMethod) paymentBadges.push(order.paymentMethod);
  if (order.paymentStatus) paymentBadges.push(order.paymentStatus);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent>
      {/* Overlay — tap does nothing (no dismiss) */}
      <Animated.View style={[s.overlay, { opacity: overlayAnim }]}>
        <Animated.View
          style={[
            s.modal,
            {
              transform: [{ scale: scaleAnim }],
            },
          ]}>
          {/* ── Header ── */}
          <View style={s.header}>
            <PulsingIcon />
            <View style={s.headerText}>
              <AnimatedLabel />
              <Text style={s.orderId} numberOfLines={1}>
                Order #{order.orderNumber || order.id}
              </Text>
              <Text style={s.itemCount}>
                {order.items.length} item{order.items.length === 1 ? '' : 's'}
              </Text>
            </View>
          </View>
          <View style={s.divider} />

          {/* ── Body: scrolls when the order is long ── */}
          <ScrollView
            style={s.scroll}
            contentContainerStyle={s.body}
            showsVerticalScrollIndicator={false}
            bounces={false}>
            <Text style={s.customerName}>{order.customerName}</Text>
            {order.customerPhone ? (
              <Text style={s.customerDetail}>📞 {order.customerPhone}</Text>
            ) : null}
            {order.deliveryAddress ? (
              <Text style={s.customerDetail}>📍 {order.deliveryAddress}</Text>
            ) : null}
            <Text style={s.time}>Received at {formatTime(order.createdAt)}</Text>

            <View style={s.itemList}>
              <Text style={s.itemListHeader}>
                Items ({order.items.length})
              </Text>
              {order.items.map(item => (
                <View key={item.id} style={s.itemRow}>
                  <Text style={s.itemName} numberOfLines={2}>
                    {item.name}
                  </Text>
                  <Text style={s.itemQty}>× {item.quantity}</Text>
                  <Text style={s.itemPrice}>
                    {item.price > 0
                      ? formatCurrency(item.total || item.price * item.quantity)
                      : '—'}
                  </Text>
                </View>
              ))}
            </View>

            <View style={s.amountRow}>
              <Text style={s.amountLabel}>Total</Text>
              <Text style={s.total}>{formatCurrency(order.grandTotal)}</Text>
            </View>

            {paymentBadges.length > 0 ? (
              <View style={s.paymentRow}>
                {paymentBadges.map((label, index) => (
                  <View key={`${label}-${index}`} style={s.paymentBadge}>
                    <Text style={s.paymentBadgeText}>{label}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </ScrollView>

          {/* ── Footer: making time and both decisions stay on screen ── */}
          <View style={s.footer}>
            {isFood ? (
              <MakingTimeStepper
                value={preparationMinutes}
                onChange={setPreparationMinutes}
              />
            ) : null}
            <View style={s.actions}>
              <Pressable
                style={({ pressed }) => [
                  s.rejectBtn,
                  pressed && s.rejectBtnPressed,
                ]}
                onPress={handleReject}
                android_ripple={{ color: Colors.dangerLight }}>
                <Text style={s.rejectText}>Reject</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [s.acceptBtn, pressed && s.acceptBtnPressed]}
                onPress={handleAccept}
                android_ripple={{ color: Colors.primaryDark }}>
                <Text style={s.acceptText}>Accept</Text>
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Styles
 * ────────────────────────────────────────────────────────────────────── */

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: Colors.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 18,
    // Keeps the capped modal clear of the status and navigation bars.
    paddingVertical: 24,
  },
  modal: {
    width: '100%',
    maxWidth: Math.min(SCREEN_WIDTH * 0.94, 430),
    maxHeight: SCREEN_HEIGHT * 0.82,
    backgroundColor: Colors.white,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: Colors.gray200,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 20,
    elevation: 8,
  },

  /* Header */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 18,
    paddingBottom: 14,
    paddingHorizontal: 18,
  },
  iconOuter: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: Colors.blobGreen1,
  },
  iconInner: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: Colors.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconEmoji: {
    fontSize: 21,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  label: {
    fontSize: 11,
    fontWeight: '800',
    color: Colors.primary,
    letterSpacing: 1.8,
    marginBottom: 1,
  },
  orderId: {
    fontSize: 17,
    fontWeight: '800',
    color: Colors.gray900,
  },
  itemCount: {
    fontSize: 12,
    color: Colors.gray500,
    marginTop: 1,
  },

  /* Divider */
  divider: {
    height: 1,
    backgroundColor: Colors.gray100,
  },

  /* Scrollable body */
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  body: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 14,
  },

  /* Customer */
  customerName: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.gray900,
    marginBottom: 3,
  },
  customerDetail: {
    fontSize: 13,
    color: Colors.gray600,
    marginBottom: 3,
    lineHeight: 18,
  },
  time: {
    fontSize: 12,
    color: Colors.gray400,
    marginBottom: 12,
  },

  /* Items */
  itemList: {
    width: '100%',
    backgroundColor: Colors.gray50,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.gray100,
    paddingTop: 12,
    paddingBottom: 8,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  itemListHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.gray500,
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 6,
  },
  itemName: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    color: Colors.gray700,
    marginRight: 8,
    lineHeight: 19,
  },
  itemQty: {
    fontSize: 13,
    color: Colors.gray500,
    fontWeight: '600',
    minWidth: 30,
    textAlign: 'right',
    marginRight: 10,
  },
  itemPrice: {
    fontSize: 13,
    color: Colors.gray800,
    fontWeight: '700',
    minWidth: 62,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },

  /* Amount + payment */
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  amountLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.gray500,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  total: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.primary,
    fontVariant: ['tabular-nums'],
  },
  paymentRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  paymentBadge: {
    backgroundColor: Colors.primaryTint,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  paymentBadgeText: {
    fontSize: 11.5,
    fontWeight: '700',
    color: Colors.primaryDark,
    letterSpacing: 0.3,
  },

  /* Footer — making time and the two decisions, never scrolled away */
  footer: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 18,
    borderTopWidth: 1,
    borderTopColor: Colors.gray100,
    backgroundColor: Colors.white,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  rejectBtn: {
    flex: 1,
    height: 52,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: Colors.dangerMuted,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectBtnPressed: {
    backgroundColor: Colors.dangerLight,
  },
  rejectText: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.danger,
    letterSpacing: 0.4,
  },
  acceptBtn: {
    flex: 1,
    height: 52,
    borderRadius: 14,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acceptBtnPressed: {
    backgroundColor: Colors.primaryDark,
  },
  acceptText: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.white,
    letterSpacing: 0.4,
  },
});
