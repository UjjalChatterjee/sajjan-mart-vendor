import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  TextInput,
  Text,
  TouchableOpacity,
  StyleSheet,
  TextInputProps,
  Animated,
} from 'react-native';
import { Colors } from '../theme/colors';

interface CustomInputProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  error?: string;
}

/**
 * Compact, modern input with animated focus border,
 * inline error, and smooth password visibility toggle.
 */
export function CustomInput({
  label,
  error,
  secureTextEntry,
  ...rest
}: CustomInputProps) {
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(true);
  const focusAnim = useRef(new Animated.Value(0)).current;
  const toggleAnim = useRef(new Animated.Value(1)).current;

  const isPassword = secureTextEntry === true;

  useEffect(() => {
    Animated.timing(focusAnim, {
      toValue: focused ? 1 : 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, [focused, focusAnim]);

  const borderColor = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['#E5E7EB', Colors.primary],
  });

  const handleToggle = () => {
    Animated.sequence([
      Animated.timing(toggleAnim, { toValue: 0.5, duration: 80, useNativeDriver: true }),
      Animated.timing(toggleAnim, { toValue: 1, duration: 80, useNativeDriver: true }),
    ]).start();
    setHidden(v => !v);
  };

  return (
    <View style={styles.container}>
      {label && <Text style={styles.label}>{label}</Text>}
      <Animated.View
        style={[
          styles.wrapper,
          { borderColor },
          error ? styles.wrapperError : null,
        ]}>
        <TextInput
          style={styles.input}
          placeholderTextColor={Colors.gray400}
          secureTextEntry={isPassword ? hidden : undefined}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          {...rest}
        />
        {isPassword && (
          <TouchableOpacity
            onPress={handleToggle}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Animated.Text
              style={[styles.toggleIcon, { opacity: toggleAnim }]}>
              {hidden ? '👁' : '👁‍🗨'}
            </Animated.Text>
          </TouchableOpacity>
        )}
      </Animated.View>
      {error ? (
        <View style={styles.errorRow}>
          <Text style={styles.errorIcon}>!</Text>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.gray600,
    marginBottom: 7,
    letterSpacing: 0.2,
  },
  wrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    paddingHorizontal: 14,
    height: 48,
  },
  wrapperError: {
    borderColor: Colors.danger,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: Colors.gray900,
    paddingVertical: 0,
    letterSpacing: 0.1,
  },
  toggleIcon: {
    fontSize: 16,
    marginLeft: 8,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    marginLeft: 2,
    gap: 4,
  },
  errorIcon: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.danger,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: Colors.dangerLight,
    textAlign: 'center',
    lineHeight: 16,
    overflow: 'hidden',
  },
  errorText: {
    fontSize: 12,
    color: Colors.danger,
    fontWeight: '500',
  },
});
