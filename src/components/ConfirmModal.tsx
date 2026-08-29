import React from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  Pressable,
  TouchableWithoutFeedback,
} from 'react-native';
import { Colors } from '../theme/colors';

export interface ConfirmModalProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Colour of the confirm button text. Defaults to Colors.danger */
  confirmColor?: string;
  /** Background tint behind the icon circle. Defaults to dangerLight */
  iconBackground?: string;
  /** Content rendered inside the icon circle (e.g. a vector icon) */
  icon?: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Reusable confirmation modal that visually matches ErrorModal.
 *
 * Two-button footer: Cancel (neutral) + Confirm (accent colour).
 * Tap-outside-to-close, Android Back to cancel.
 */
export function ConfirmModal({
  visible,
  title,
  message,
  confirmLabel = 'CONFIRM',
  cancelLabel = 'CANCEL',
  confirmColor = Colors.danger,
  iconBackground = '#FDE8E8',
  icon,
  onCancel,
  onConfirm,
}: ConfirmModalProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={styles.overlay}>
        {/* Backdrop — tap outside to close */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />

        {/* Modal Card */}
        <TouchableWithoutFeedback>
          <View style={styles.card}>
            {/* Icon */}
            {icon && (
              <View style={[styles.iconContainer, { backgroundColor: iconBackground }]}>
                {icon}
              </View>
            )}

            {/* Content */}
            <View style={styles.content}>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.message}>{message}</Text>
            </View>

            {/* Footer */}
            <View style={styles.footer}>
              <View style={styles.footerRow}>
                <Pressable
                  onPress={onCancel}
                  style={({ pressed }) => [
                    styles.cancelButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.cancelText}>{cancelLabel}</Text>
                </Pressable>

                <View style={styles.footerDivider} />

                <Pressable
                  onPress={onConfirm}
                  style={({ pressed }) => [
                    styles.confirmButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={[styles.confirmText, { color: confirmColor }]}>
                    {confirmLabel}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </View>
    </Modal>
  );
}

/* ── Logout-specific icon drawn with basic RN Views (no emoji, no font) ── */

/**
 * Geometric logout icon: a door frame (partial rectangle) with an arrow
 * pointing right — renders correctly on all Android devices.
 */
export function LogoutIcon({ size = 24, color = Colors.danger }: { size?: number; color?: string }) {
  const doorH = size * 0.68;
  const doorW = size * 0.52;
  const barThick = Math.max(2, size * 0.09);
  const arrowLen = size * 0.42;
  const arrowShaftH = Math.max(2, size * 0.09);

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {/* Door frame + arrow row */}
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {/* Door frame: top bar + left bar + bottom bar */}
        <View style={{ width: doorW, height: doorH, justifyContent: 'space-between' }}>
          {/* Top bar */}
          <View style={{ width: doorW, height: barThick, backgroundColor: color, borderRadius: 1 }} />
          {/* Left bar (full height minus top & bottom bars) */}
          <View style={{ position: 'absolute', left: 0, top: 0, width: barThick, height: doorH, backgroundColor: color, borderRadius: 1 }} />
          {/* Bottom bar */}
          <View style={{ width: doorW, height: barThick, backgroundColor: color, borderRadius: 1 }} />
        </View>

        {/* Arrow shaft */}
        <View style={{ width: arrowLen, height: arrowShaftH, backgroundColor: color, borderRadius: 1, marginLeft: -1 }} />

        {/* Arrow head (triangle using borders) */}
        <View
          style={{
            width: 0,
            height: 0,
            borderTopWidth: arrowShaftH * 1.6,
            borderBottomWidth: arrowShaftH * 1.6,
            borderLeftWidth: arrowShaftH * 1.4,
            borderLeftColor: color,
            borderTopColor: 'transparent',
            borderBottomColor: 'transparent',
            marginLeft: -1,
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },

  card: {
    width: '88%',
    maxWidth: 380,
    backgroundColor: Colors.white,
    borderRadius: 24,
    overflow: 'hidden',
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
  },

  iconContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginTop: 28,
    marginBottom: 20,
  },

  content: {
    paddingHorizontal: 28,
    alignItems: 'center',
  },

  title: {
    fontSize: 22,
    fontWeight: '700',
    color: Colors.gray900,
    textAlign: 'center',
    marginBottom: 10,
  },

  message: {
    fontSize: 15,
    fontWeight: '400',
    color: Colors.gray600,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 28,
  },

  footer: {
    width: '100%',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.gray300,
  },

  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  cancelButton: {
    flex: 1,
    minHeight: 58,
    alignItems: 'center',
    justifyContent: 'center',
  },

  confirmButton: {
    flex: 1,
    minHeight: 58,
    alignItems: 'center',
    justifyContent: 'center',
  },

  footerDivider: {
    width: StyleSheet.hairlineWidth,
    height: '100%',
    backgroundColor: Colors.gray300,
  },

  buttonPressed: {
    backgroundColor: '#F5F5F5',
  },

  cancelText: {
    color: Colors.gray600,
    fontSize: 16,
    fontWeight: '600',
  },

  confirmText: {
    fontSize: 16,
    fontWeight: '700',
  },
});
