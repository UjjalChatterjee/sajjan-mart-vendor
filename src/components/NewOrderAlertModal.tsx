import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Animated,
  Dimensions,
  Pressable,
} from 'react-native';
import { Colors } from '../theme/colors';
import type { Order } from '../types';
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
 * Pulsing order icon
 * ────────────────────────────────────────────────────────────────────── */

function PulsingIcon() {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.1,
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
  const opacityAnim = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    const attention = Animated.loop(
      Animated.sequence([
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0.6,
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
  onAccept: (orderId: string) => void;
  onReject: (orderId: string) => void;
}

/* ──────────────────────────────────────────────────────────────────────
 * NewOrderAlertModal
 *
 * The ONLY place in the app where Accept / Reject actions exist.
 * Cannot be dismissed by tapping outside, swiping, or auto-timer.
 * ────────────────────────────────────────────────────────────────────── */

export function NewOrderAlertModal({
  visible,
  order,
  onAccept,
  onReject,
}: NewOrderAlertModalProps) {
  const overlayAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.95)).current;

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

  if (!order) return null;

  const handleAccept = () => {
    stopOrderAlertSound();
    onAccept(order.id);
  };

  const handleReject = () => {
    stopOrderAlertSound();
    onReject(order.id);
  };

  const previewItems = order.items.slice(0, 3);
  const extraCount = order.items.length - 3;

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
          {/* ── Icon ── */}
          <PulsingIcon />

          {/* ── NEW ORDER ── */}
          <AnimatedLabel />
          <Text style={s.orderId}>Order #{order.orderNumber || order.id}</Text>

          {/* ── Divider ── */}
          <View style={s.divider} />

          {/* ── Customer ── */}
          <Text style={s.customerName}>{order.customerName}</Text>
          <Text style={s.meta}>
            {order.items.length} Item{order.items.length !== 1 ? 's' : ''}
          </Text>
          <Text style={s.time}>Order received at {formatTime(order.createdAt)}</Text>

          {/* ── Items ── */}
          <View style={s.itemList}>
            {previewItems.map(item => (
              <View key={item.id} style={s.itemRow}>
                <Text style={s.itemName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={s.itemQty}>× {item.quantity}</Text>
              </View>
            ))}
            {extraCount > 0 && (
              <Text style={s.moreItems}>
                + {extraCount} more item{extraCount !== 1 ? 's' : ''}
              </Text>
            )}
          </View>

          {/* ── Total ── */}
          <Text style={s.total}>{formatCurrency(order.grandTotal)}</Text>

          {/* ── Actions ── */}
          <View style={s.actions}>
            <Pressable
              style={s.rejectBtn}
              onPress={handleReject}
              android_ripple={{ color: Colors.dangerLight }}>
              <Text style={s.rejectText}>Reject</Text>
            </Pressable>
            <Pressable
              style={s.acceptBtn}
              onPress={handleAccept}
              android_ripple={{ color: Colors.primaryDark }}>
              <Text style={s.acceptText}>Accept</Text>
            </Pressable>
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Styles
 * ────────────────────────────────────────────────────────────────────── */

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  modal: {
    width: '100%',
    maxWidth: SCREEN_WIDTH * 0.9,
    backgroundColor: Colors.white,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    paddingTop: 28,
    paddingBottom: 24,
    paddingHorizontal: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 6,
  },

  /* Icon */
  iconOuter: {
    width: 68,
    height: 68,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  pulseRing: {
    position: 'absolute',
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: 'rgba(34, 197, 94, 0.1)',
  },
  iconInner: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.22,
    shadowRadius: 6,
    elevation: 4,
  },
  iconEmoji: {
    fontSize: 24,
  },

  /* Labels */
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.primary,
    letterSpacing: 2.5,
    marginBottom: 6,
  },
  orderId: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.gray900,
    marginBottom: 16,
  },

  /* Divider */
  divider: {
    width: '100%',
    height: 1,
    backgroundColor: '#F3F4F6',
    marginBottom: 16,
  },

  /* Customer */
  customerName: {
    fontSize: 17,
    fontWeight: '700',
    color: Colors.gray900,
    marginBottom: 3,
  },
  meta: {
    fontSize: 14,
    color: Colors.gray500,
    marginBottom: 2,
  },
  time: {
    fontSize: 13,
    color: Colors.gray400,
    marginBottom: 16,
  },

  /* Items */
  itemList: {
    width: '100%',
    backgroundColor: '#F9FAFB',
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  itemName: {
    flex: 1,
    fontSize: 14,
    color: Colors.gray700,
    marginRight: 10,
  },
  itemQty: {
    fontSize: 13,
    color: Colors.gray500,
    fontWeight: '500',
  },
  moreItems: {
    fontSize: 13,
    color: Colors.gray400,
    marginTop: 4,
  },

  /* Total */
  total: {
    fontSize: 28,
    fontWeight: '800',
    color: Colors.primary,
    marginBottom: 22,
  },

  /* Actions */
  actions: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  rejectBtn: {
    flex: 1,
    height: 54,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#FCA5A5',
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectText: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.danger,
    letterSpacing: 0.4,
  },
  acceptBtn: {
    flex: 1.3,
    height: 54,
    borderRadius: 14,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.22,
    shadowRadius: 6,
    elevation: 4,
  },
  acceptText: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.white,
    letterSpacing: 0.4,
  },
});
