import React from 'react';
import { View, Text, StyleSheet, } from 'react-native';

/**
 * Simple Toast notification component.
 * Shows a message at the bottom of the screen and auto-hides after 2 seconds.
 *
 * Usage: <Toast message="Registration successful" />
 * The toast automatically appears and fades out after 2 seconds.
 */

type ToastProps = {
  message: string;
  /** Override default duration in ms */
  duration?: number;
  /** Internal control - visible state */
  visible?: boolean;
  onClose?: () => void;
};

const DEFAULT_DURATION = 2000;

export function Toast({
  message,
  duration = DEFAULT_DURATION,
  visible: controlledVisible,
  onClose,
}: ToastProps) {
  const [visible, setVisible] = React.useState(controlledVisible ?? true);

  React.useEffect(() => {
    if (visible) {
      const timer = setTimeout(() => setVisible(false), duration);
      return () => clearTimeout(timer);
    }
  }, [visible, duration]);

  if (!visible) return null;

  return (
    <View style={styles.container}>
      <View style={styles.toast}>
        <Text style={styles.text}>{message}</Text>
        {onClose ? (
          <Text style={styles.closeText} onPress={onClose}>✕</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 40,
    left: '50%',
    transform: [{ translateX: -120 }],
    zIndex: 999,
    marginBottom: 16,
  },
  toast: {
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  text: {
    color: 'white',
    fontSize: 14,
    lineHeight: 18,
  },
  closeText: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 12,
    marginLeft: 8,
  },
});