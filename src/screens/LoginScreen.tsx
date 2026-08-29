import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Dimensions,
  Animated,
  Easing,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../theme/colors';
import { GradientBackground } from '../components/GradientBackground';
import { GlassButton } from '../components/GlassButton';
import { CustomInput } from '../components/CustomInput';
import { useNavigation } from '../context/NavigationContext';
import { useAuth } from '../context/AuthContext';
import { login as authLogin, fetchCurrentUser, isApiError } from '../services/auth.service';
import { initializeNotifications } from '../services/notification.service';
import { useToast } from '../context/ToastContext';
import { ErrorModal } from '../components/ErrorModal';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

/**
 * Compact, professional login screen for Sajjan Mart.
 *
 * Design principles:
 *  - Minimal, premium SaaS aesthetic
 *  - Clean solid white card centered on screen
 *  - Compact inputs, subtle errors, smooth micro-interactions
 *  - Optimised for 360–430 px Android phones
 */

/* ──────────────────────────────── Logo ──────────────────────────────── */

function BrandMark() {
  return (
    <View style={logoStyles.container}>
      {/* Green rounded square base */}
      <View style={logoStyles.base}>
        {/* White leaf accent — two overlapping circles */}
        <View style={logoStyles.leafTop} />
        <View style={logoStyles.leafBottom} />
      </View>
    </View>
  );
}

const LOGO_SIZE = 66;

const logoStyles = StyleSheet.create({
  container: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    marginBottom: 20,
  },
  base: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    borderRadius: 18,
    backgroundColor: Colors.primary,
    overflow: 'hidden',
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 6,
  },
  leafTop: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.95)',
    top: 14,
    left: 12,
  },
  leafBottom: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.primaryLight,
    top: 20,
    left: 20,
  },
});

/* ──────────────────────────── Login Screen ─────────────────────────── */

export function LoginScreen() {
  const { navigate } = useNavigation();
  const { setAuthenticated } = useAuth();

  /* form state */
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
  }>({});
  const { showSuccess } = useToast();
  const [errorModalVisible, setErrorModalVisible] = useState(false);
  const [errorModalMessage, setErrorModalMessage] = useState<string>('');

  /* entrance animation */
  const cardAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(cardAnim, {
      toValue: 1,
      duration: 500,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [cardAnim]);

  const cardTranslateY = cardAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [24, 0],
  });

  /* ── validation ── */
  const validate = (): boolean => {
    const errors: typeof fieldErrors = {};
    if (!email.trim()) {
      errors.email = 'Email is required';
    }
    if (!password.trim()) {
      errors.password = 'Password is required';
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  /* ── submit ── */
  const handleLogin = async () => {
    if (!validate()) return;
    if (loading) return; // prevent double-tap

    setLoading(true);
    try {
      const result = await authLogin(email.trim(), password);

      // Update auth state — tokens are saved by auth.service
      setAuthenticated(result.user);

      // Refresh user data from /api/auth/me to ensure state is current
      try {
        const freshUser = await fetchCurrentUser();
        setAuthenticated(freshUser);
      } catch {
        // Non-fatal: keep the login-response user
      }

      // Show success toast
      showSuccess('Login successful');

      // Initialize FCM notifications after successful login.
      await initializeNotifications();
      navigate('orders');
    } catch (error: unknown) {
      if (isApiError(error, 401)) {
        setErrorModalMessage('Invalid email or password');
        setErrorModalVisible(true);
      } else if (isApiError(error, 400)) {
        setErrorModalMessage(error.message || 'Email and password are required');
        setErrorModalVisible(true);
      } else if (isApiError(error, 500)) {
        setErrorModalMessage('Login failed');
        setErrorModalVisible(true);
      } else if (isApiError(error)) {
        setErrorModalMessage(error.message || 'Something went wrong. Please try again.');
        setErrorModalVisible(true);
      } else {
        // Network or server error
        setErrorModalMessage('Unable to connect to the server. Please check your internet connection and try again.');
        setErrorModalVisible(true);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <GradientBackground />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}>
          {/* ── Brand ── */}
          <View style={styles.brand}>
            <BrandMark />
            <Text style={styles.brandName}>Sajjan Mart</Text>
            <Text style={styles.brandTagline}>Manage your store orders</Text>
          </View>

          {/* ── Login Card ── */}
          <Animated.View
            style={[
              styles.cardWrapper,
              {
                opacity: cardAnim,
                transform: [{ translateY: cardTranslateY }],
              },
            ]}>
            <View style={styles.card}>
              <View style={styles.cardContent}>
                <Text style={styles.cardTitle}>Welcome back</Text>
                <Text style={styles.cardSubtitle}>
                  Sign in to manage your orders
                </Text>

                <View style={styles.form}>
                  <CustomInput
                    label="Email"
                    placeholder="Enter email"
                    value={email}
                    onChangeText={t => {
                      setEmail(t);
                      if (fieldErrors.email) {
                        setFieldErrors(prev => ({
                          ...prev,
                          email: undefined,
                        }));
                      }
                    }}
                    autoCapitalize="none"
                    autoComplete="email"
                    keyboardType="email-address"
                    error={fieldErrors.email}
                  />

                  <CustomInput
                    label="Password"
                    placeholder="Enter password"
                    value={password}
                    onChangeText={t => {
                      setPassword(t);
                      if (fieldErrors.password) {
                        setFieldErrors(prev => ({
                          ...prev,
                          password: undefined,
                        }));
                      }
                    }}
                    secureTextEntry
                    autoCapitalize="none"
                    error={fieldErrors.password}
                  />

                  <GlassButton
                    title="Sign In"
                    onPress={handleLogin}
                    loading={loading}
                    disabled={loading}
                    fullWidth
                    size="medium"
                    style={styles.signInBtn}
                  />
                </View>
              </View>
            </View>
          </Animated.View>

          {/* ── Footer ── */}
          <Text style={styles.footer}>
            Sajjan Mart{'  '}•{'  '}Store Management
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>


      <ErrorModal
        visible={errorModalVisible}
        title="Login Failed"
        message={errorModalMessage}
        onClose={() => setErrorModalVisible(false)}
      />
    </SafeAreaView>
  );
}

/* ──────────────────────────── Styles ───────────────────────────────── */

const CARD_HORIZONTAL = Math.max(24, (SCREEN_WIDTH - 380) / 2 + 24);

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.screenBg,
  },
  flex: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: CARD_HORIZONTAL,
    paddingBottom: 32,
  },

  /* Brand */
  brand: {
    alignItems: 'center',
    marginBottom: 28,
  },
  brandName: {
    fontSize: 24,
    fontWeight: '700',
    color: Colors.gray900,
    letterSpacing: 0.4,
    marginBottom: 5,
  },
  brandTagline: {
    fontSize: 14,
    fontWeight: '400',
    color: Colors.gray500,
    letterSpacing: 0.2,
  },

  /* Card */
  cardWrapper: {
    marginBottom: 36,
  },
  card: {
    padding: 0,
    backgroundColor: Colors.white,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.06)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
  },
  cardContent: {
    paddingHorizontal: 26,
    paddingVertical: 28,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.gray900,
    marginBottom: 4,
  },
  cardSubtitle: {
    fontSize: 13,
    fontWeight: '400',
    color: Colors.gray500,
    marginBottom: 24,
    letterSpacing: 0.1,
  },

  /* Form */
  form: {
    gap: 0,
  },
  signInBtn: {
    marginTop: 8,
  },

  /* Footer */
  footer: {
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '400',
    color: Colors.gray400,
    letterSpacing: 0.3,
  },
});
