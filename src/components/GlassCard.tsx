import React, { ReactNode } from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { Colors } from '../theme/colors';

interface GlassCardProps {
  children: ReactNode;
  style?: ViewStyle;
  variant?: 'default' | 'light' | 'subtle' | 'frosted';
  noPadding?: boolean;
}

const variantOverrides: Record<string, ViewStyle> = {
  light: { backgroundColor: 'rgba(255, 255, 255, 0.85)' },
  subtle: { backgroundColor: 'rgba(255, 255, 255, 0.45)', shadowOpacity: 0.03 },
  frosted: {
    backgroundColor: 'rgba(255, 255, 255, 0.58)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.7)',
  },
};

export function GlassCard({
  children,
  style,
  variant = 'default',
  noPadding,
}: GlassCardProps) {
  return (
    <View
      style={[
        styles.card,
        variantOverrides[variant],
        noPadding && styles.noPadding,
        style,
      ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.cardBg,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 12,
    elevation: 3,
  },
  noPadding: {
    padding: 0,
  },
});
