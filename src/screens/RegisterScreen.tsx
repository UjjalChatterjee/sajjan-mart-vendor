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
import { signup, isApiError } from '../services/auth.service';
import { Toast } from '../components/Toast';
import { ErrorModal } from '../components/ErrorModal';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

/**
 * Staff registration screen for Sajjan Mart.
 *
 * Matches the Login screen design system:
 *  - Clean solid white card on a subtle gradient background
 *  - Same BrandMark, typography, and micro-interactions
 *  - No glassmorphism
 *  - Compact, professional SaaS aesthetic
 */

/* ──────────────────────────────── Logo ──────────────────────────────── */

function BrandMark() {
  return (
    <View style={logoStyles.container}>
      <View style={logoStyles.base}>
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

/* ──────────────────────────── Register Screen ───────────────────────── */

type FormField = 'email' | 'password' | 'fullName';

interface FieldErrors {
  email?: string;
  password?: string;
  fullName?: string;
}

export function RegisterScreen() {
  const { navigate } = useNavigation();
  const { setAuthenticated } = useAuth();

  /* form state */
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [errorModalVisible, setErrorModalVisible] = useState(false);
  const [errorModalMessage, setErrorModalMessage] = useState<string>('');

  /* entrance animation (same as LoginScreen) */
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

  /* ── helpers ── */

  const clearError = (field: FormField) => {
    if (fieldErrors[field]) {
      setFieldErrors(prev => ({ ...prev, [field]: undefined }));
    }
  };

  /* ── validation ── */

  const validate = (): boolean => {
    const errors: FieldErrors = {};

    /* Email */
    if (!email.trim()) {
      errors.email = 'Email is required';
    }

    /* Password */
    if (!password) {
      errors.password = 'Password is required';
    } else if (password.length < 6) {
      errors.password = 'Password must be at least 6 characters';
    }

    /* Full Name */
    if (!fullName.trim()) {
      errors.fullName = 'Full name is required';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  /* ── submit ── */

  const handleRegister = async () => {
    if (!validate()) return;
    if (loading) return;

    setLoading(true);
    try {
      const result = await signup(email, password, fullName);

      // Registration successful — tokens are saved by auth.service
      // Show success toast, then update auth state and navigate
      setToastMessage('Registration successful');
      setAuthenticated(result.user);
      navigate('orders');
    } catch (error: unknown) {
      let message = 'Something went wrong. Please try again.';

      if (isApiError(error, 409)) {
        message = 'Email already registered';
        setErrorModalMessage(message);
        setErrorModalVisible(true);
      } else if (isApiError(error, 400)) {
        message = error.message || 'Please check your input and try again.';
        setErrorModalMessage(message);
        setErrorModalVisible(true);
      } else if (isApiError(error)) {
        message = error.message || message;
        setErrorModalMessage(message);
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
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {/* ── Brand ── */}
          <View style={styles.brand}>
            <BrandMark />
            <Text style={styles.brandName}>Sajjan Mart</Text>
            <Text style={styles.brandTagline}>Manage your store orders</Text>
          </View>

          {/* ── Registration Card ── */}
          <Animated.View
            style={[
              styles.cardWrapper,
              {
                opacity: cardAnim,
                transform: [{ translateY: cardTranslateY }],
              },
            ]}
          >
            <View style={styles.card}>
              <View style={styles.cardContent}>
                <Text style={styles.cardTitle}>Create Account</Text>
                <Text style={styles.cardSubtitle}>
                  Register your Sajjan Mart staff account
                </Text>

                <View style={styles.form}>
                  {/* Full Name */}
                  <CustomInput
                    label="Full Name"
                    placeholder="Enter full name"
                    value={fullName}
                    onChangeText={t => {
                      setFullName(t);
                      clearError('fullName');
                    }}
                    autoCapitalize="none"
                    autoComplete="name"
                    error={fieldErrors.fullName}
                  />

                  {/* Email */}
                  <CustomInput
                    label="Email"
                    placeholder="Enter email"
                    value={email}
                    onChangeText={t => {
                      setEmail(t);
                      clearError('email');
                    }}
                    autoCapitalize="none"
                    autoComplete="email"
                    error={fieldErrors.email}
                  />

                  {/* Password */}
                  <CustomInput
                    label="Password"
                    placeholder="Enter password"
                    value={password}
                    onChangeText={t => {
                      setPassword(t);
                      clearError('password');
                    }}
                    secureTextEntry
                    autoCapitalize="none"
                    error={fieldErrors.password}
                  />

                  <GlassButton
                    title="REGISTER"
                    onPress={handleRegister}
                    loading={loading}
                    disabled={loading}
                    fullWidth
                    size="medium"
                    style={styles.registerBtn}
                  />

                  {/* ── Login Link ── */}
                  <View style={styles.loginRow}>
                    <Text style={styles.loginText}>
                      Already have an account?{' '}
                    </Text>
                    <GlassButton
                      title="Login"
                      variant="ghost"
                      size="small"
                      onPress={() => navigate('login')}
                      style={styles.signInLink}
                    />
                  </View>
                </View>
              </View>
            </View>
          </Animated.View>

          {/* ── Footer ── */}
          <Text style={styles.footer}>
            Sajjan Mart{'  '}•{'  '}Store Management
          </Text>
          {toastMessage && <Toast message={toastMessage} />}

          {errorModalVisible && <ErrorModal
            visible={errorModalVisible}
            title="Registration Failed"
            message={errorModalMessage}
            onClose={() => setErrorModalVisible(false)}
          />}

        </ScrollView>
      </KeyboardAvoidingView>
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
  registerBtn: {
    marginTop: 8,
  },

  /* Login link */
  loginRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  loginText: {
    fontSize: 13,
    fontWeight: '400',
    color: Colors.gray500,
  },
  signInLink: {
    paddingHorizontal: 4,
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
