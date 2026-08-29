import React, { useRef } from 'react';
import {
  TouchableOpacity,
  Text,
  StyleSheet,
  ViewStyle,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { Colors } from '../theme/colors';

interface GlassButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'small' | 'medium' | 'large';
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  fullWidth?: boolean;
}

/**
 * Premium button with press-scale micro-interaction.
 * medium = 52px height, 14px radius (default for login).
 */
export function GlassButton({
  title,
  onPress,
  variant = 'primary',
  size = 'medium',
  loading = false,
  disabled = false,
  style,
  fullWidth = false,
}: GlassButtonProps) {
  const isDisabled = disabled || loading;
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const onPressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.97,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  };

  const onPressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  };

  return (
    <Animated.View style={[{ transform: [{ scale: scaleAnim }] }, fullWidth && { width: '100%' }]}>
      <TouchableOpacity
        style={[
          styles.button,
          styles[variant],
          styles[size],
          isDisabled && styles.disabled,
          style,
        ]}
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        disabled={isDisabled}
        activeOpacity={0.8}>
        {loading ? (
          <ActivityIndicator
            color={
              variant === 'primary' || variant === 'danger'
                ? Colors.white
                : Colors.primary
            }
            size="small"
          />
        ) : (
          <Text
            style={[
              styles.text,
              styles[`${variant}Text`],
              styles[`${size}Text`],
            ]}>
            {title}
          </Text>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  // Sizes — medium is the canonical login button height (52px)
  small: {
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  medium: {
    paddingVertical: 15,
    paddingHorizontal: 24,
    minHeight: 52,
  },
  large: {
    paddingVertical: 17,
    paddingHorizontal: 32,
    minHeight: 56,
  },
  // Variants
  primary: {
    backgroundColor: Colors.primary,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 4,
  },
  secondary: {
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  danger: {
    backgroundColor: Colors.danger,
    shadowColor: Colors.danger,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 4,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
  // Text sizes
  smallText: {
    fontSize: 13,
    fontWeight: '600',
  },
  mediumText: {
    fontSize: 15,
    fontWeight: '600',
  },
  largeText: {
    fontSize: 16,
    fontWeight: '700',
  },
  // Text colors
  text: {
    letterSpacing: 0.3,
  },
  primaryText: {
    color: Colors.white,
  },
  secondaryText: {
    color: Colors.gray700,
  },
  dangerText: {
    color: Colors.white,
  },
  ghostText: {
    color: Colors.danger,
  },
  // Disabled
  disabled: {
    opacity: 0.5,
  },
});
