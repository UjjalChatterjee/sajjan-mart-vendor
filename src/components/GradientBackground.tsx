import React from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import { Colors } from '../theme/colors';

const { width, height } = Dimensions.get('window');

/**
 * Subtle abstract background with small, edge-located gradient blobs.
 * Designed to peek through glassmorphism cards without dominating.
 */
export function GradientBackground() {
  return (
    <View style={styles.root}>
      <View style={[styles.blob, styles.blobTopRight]} />
      <View style={[styles.blob, styles.blobBottomLeft]} />
      <View style={[styles.blob, styles.blobMidRight]} />
    </View>
  );
}

const BLOB_SIZE = width * 0.28;

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    overflow: 'hidden',
  },
  blob: {
    position: 'absolute',
    width: BLOB_SIZE,
    height: BLOB_SIZE,
    borderRadius: 999,
  },
  blobTopRight: {
    backgroundColor: 'rgba(34, 197, 94, 0.08)',
    top: -BLOB_SIZE * 0.35,
    right: -BLOB_SIZE * 0.3,
  },
  blobBottomLeft: {
    backgroundColor: 'rgba(167, 243, 208, 0.12)',
    bottom: -BLOB_SIZE * 0.25,
    left: -BLOB_SIZE * 0.3,
  },
  blobMidRight: {
    backgroundColor: 'rgba(74, 222, 128, 0.06)',
    top: height * 0.55,
    right: -BLOB_SIZE * 0.4,
  },
});
