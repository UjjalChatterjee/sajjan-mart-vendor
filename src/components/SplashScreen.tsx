import React, { useEffect, useRef } from 'react';
import {
  View,
  Image,
  Text,
  StyleSheet,
  Animated,
  Easing,
  Dimensions,
} from 'react-native';

const { width, height } = Dimensions.get('window');

// Brand color matching Android native splash and launcher icon
const BRAND_COLOR = '#F93B3B';

interface SplashScreenProps {
  onAnimationComplete: () => void;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ onAnimationComplete }) => {
  const logoScale = useRef(new Animated.Value(0.8)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const textTranslateY = useRef(new Animated.Value(20)).current;
  const shimmerOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const runAnimation = async () => {
      // Phase 1: Background is already visible via native splash/theme
      
      // Phase 2: Logo scale + fade in
      await Animated.parallel([
        Animated.timing(logoScale, {
          toValue: 1,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(logoOpacity, {
          toValue: 1,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();

      // Phase 3: Text fade/slide in
      await Animated.parallel([
        Animated.timing(textOpacity, {
          toValue: 1,
          duration: 400,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(textTranslateY, {
          toValue: 0,
          duration: 400,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();

      // Phase 4: Subtle shimmer/glow
      await Animated.timing(shimmerOpacity, {
        toValue: 1,
        duration: 500,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
      }).start();

      // Phase 5: Hold briefly
      await new Promise(resolve => setTimeout(resolve, 300));

      // Phase 6: Fade out and transition
      await Animated.parallel([
        Animated.timing(logoOpacity, {
          toValue: 0,
          duration: 300,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(textOpacity, {
          toValue: 0,
          duration: 300,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(shimmerOpacity, {
          toValue: 0,
          duration: 300,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();

      onAnimationComplete();
    };

    runAnimation();
  }, [onAnimationComplete]);

  const logoAnimatedStyle = {
    transform: [{ scale: logoScale }],
    opacity: logoOpacity,
  };

  const textAnimatedStyle = {
    opacity: textOpacity,
    transform: [{ translateY: textTranslateY }],
  };

  const shimmerStyle = {
    opacity: shimmerOpacity,
  };

  return (
    <View style={styles.container}>
      <View style={styles.logoContainer}>
        <Animated.Image
          source={require('../assets/logo.png')}
          style={[
            styles.logo,
            logoAnimatedStyle,
            shimmerStyle,
          ]}
          resizeMode="contain"
        />
        <Animated.View style={[styles.shimmer, shimmerStyle]} />
      </View>
      <Animated.Text style={[styles.text, textAnimatedStyle]}>SajjanMart</Animated.Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BRAND_COLOR,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoContainer: {
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logo: {
    width: 140,
    height: 140,
  },
  shimmer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 70,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  text: {
    marginTop: 20,
    fontSize: 28,
    fontWeight: '600',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
});