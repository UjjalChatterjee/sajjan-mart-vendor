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

export interface ErrorModalProps {
  visible: boolean;
  title: string;
  message: string;
  onClose: () => void;
}

export function ErrorModal({
  visible,
  title,
  message,
  onClose,
}: ErrorModalProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        {/* Backdrop - tap outside to close */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        {/* Modal Card */}
        <TouchableWithoutFeedback>
          <View style={styles.card}>
            {/* Error Icon */}
            <View style={styles.iconContainer}>
              <Text style={styles.icon}>!</Text>
            </View>

            {/* Content */}
            <View style={styles.content}>
              <Text style={styles.title}>{title}</Text>

              <Text style={styles.message}>{message}</Text>
            </View>

            {/* Footer */}
            <View style={styles.footer}>
              <Pressable
                onPress={onClose}
                style={({ pressed }) => [
                  styles.okButton,
                  pressed && styles.okButtonPressed,
                ]}
              >
                <Text style={styles.okText}>OK</Text>
              </Pressable>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </View>
    </Modal>
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
    shadowOffset: {
      width: 0,
      height: 6,
    },
    shadowOpacity: 0.2,
    shadowRadius: 16,
  },

  iconContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#FDE8E8',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginTop: 28,
    marginBottom: 20,
  },

  icon: {
    color: '#DC2626',
    fontSize: 38,
    fontWeight: '800',
    lineHeight: 44,
    textAlign: 'center',
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

  okButton: {
    width: '100%',
    minHeight: 58,
    alignItems: 'center',
    justifyContent: 'center',
  },

  okButtonPressed: {
    backgroundColor: '#F5F5F5',
  },

  okText: {
    color: Colors.primary,
    fontSize: 16,
    fontWeight: '700',
  },
});
