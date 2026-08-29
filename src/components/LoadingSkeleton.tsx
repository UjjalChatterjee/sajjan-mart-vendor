import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { Colors } from '../theme/colors';

function SkeletonPulse({ style }: { style?: object }) {
  const pulseAnim = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.7,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0.3,
          duration: 1000,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [pulseAnim]);

  return (
    <Animated.View
      style={[
        {
          backgroundColor: '#E5E7EB',
          borderRadius: 8,
          opacity: pulseAnim,
        },
        style,
      ]}
    />
  );
}

export function OrderCardSkeleton() {
  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <SkeletonPulse style={{ width: 90, height: 18 }} />
        <SkeletonPulse style={{ width: 60, height: 22, borderRadius: 11 }} />
      </View>
      <SkeletonPulse style={{ width: 160, height: 18, marginTop: 12 }} />
      <SkeletonPulse style={{ width: 70, height: 14, marginTop: 6 }} />
      <View style={styles.summaryRow}>
        <SkeletonPulse style={{ width: 70, height: 20 }} />
        <SkeletonPulse style={{ width: 60, height: 14 }} />
      </View>
      <SkeletonPulse style={{ width: '80%', height: 14, marginTop: 12 }} />
      <SkeletonPulse style={{ width: '55%', height: 14, marginTop: 6 }} />
    </View>
  );
}

export function OrderDetailsSkeleton() {
  return (
    <View style={styles.detailsContainer}>
      <View style={[styles.detailCard, { alignItems: 'center', paddingVertical: 24 }]}>
        <SkeletonPulse style={{ width: 120, height: 22 }} />
        <SkeletonPulse style={{ width: 80, height: 26, borderRadius: 13, marginTop: 12 }} />
      </View>

      <View style={[styles.detailCard, { paddingVertical: 24 }]}>
        <SkeletonPulse style={{ width: 140, height: 16, marginBottom: 14 }} />
        <SkeletonPulse style={{ width: '80%', height: 18, marginBottom: 10 }} />
        <SkeletonPulse style={{ width: '60%', height: 14 }} />
      </View>

      {[1, 2, 3].map(i => (
        <View key={i} style={styles.detailCard}>
          <View style={styles.skeletonItemRow}>
            <SkeletonPulse style={{ width: 44, height: 44, borderRadius: 12 }} />
            <View style={{ flex: 1, marginLeft: 14 }}>
              <SkeletonPulse style={{ width: '70%', height: 16, marginBottom: 8 }} />
              <SkeletonPulse style={{ width: '40%', height: 13 }} />
            </View>
            <SkeletonPulse style={{ width: 60, height: 18 }} />
          </View>
        </View>
      ))}
    </View>
  );
}

export function UserInfoSkeleton() {
  return (
    <View style={styles.userInfoRow}>
      <SkeletonPulse style={{ width: 40, height: 40, borderRadius: 20 }} />
      <View style={{ marginLeft: 12 }}>
        <SkeletonPulse style={{ width: 100, height: 16, marginBottom: 6 }} />
        <SkeletonPulse style={{ width: 70, height: 12 }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 18,
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
  },
  detailCard: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 18,
    marginBottom: 12,
  },
  detailsContainer: {
    padding: 16,
  },
  skeletonItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  userInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
