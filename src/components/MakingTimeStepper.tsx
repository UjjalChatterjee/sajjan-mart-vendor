import React from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { Colors } from '../theme/colors';
import {
  PREP_MAX_MINUTES,
  PREP_MIN_MINUTES,
  clampPreparationMinutes,
} from '../services/prepTimer';

interface MakingTimeStepperProps {
  value: number;
  onChange: (minutes: number) => void;
}

/**
 * The making-time selector, shared by the new-order popup and the order card in
 * the New Order tab — both are accept surfaces, and the vendor must be able to
 * set the kitchen time on whichever one they happen to be looking at.
 */
export function MakingTimeStepper({ value, onChange }: MakingTimeStepperProps) {
  const step = (delta: number) => onChange(clampPreparationMinutes(value + delta));
  const atFloor = value <= PREP_MIN_MINUTES;
  const atCeiling = value >= PREP_MAX_MINUTES;

  return (
    <View style={s.container}>
      <Text style={s.label}>Making Time</Text>
      <View style={s.controls}>
        <Pressable
          testID="prep-minus"
          style={[s.stepBtn, atFloor && s.stepBtnDisabled]}
          disabled={atFloor}
          onPress={() => step(-1)}>
          <Text style={[s.stepText, atFloor && s.stepTextDisabled]}>−</Text>
        </Pressable>
        <View style={s.valuePill}>
          <Text style={s.value} testID="prep-minutes">
            {value} min
          </Text>
        </View>
        <Pressable
          testID="prep-plus"
          style={[s.stepBtn, atCeiling && s.stepBtnDisabled]}
          disabled={atCeiling}
          onPress={() => step(1)}>
          <Text style={[s.stepText, atCeiling && s.stepTextDisabled]}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    width: '100%',
    alignItems: 'center',
    backgroundColor: Colors.primaryTintSoft,
    borderWidth: 1,
    borderColor: Colors.primaryTint,
    borderRadius: 18,
    paddingTop: 12,
    paddingBottom: 14,
    paddingHorizontal: 14,
    marginBottom: 16,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.primaryDark,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  stepBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.white,
  },
  stepBtnDisabled: {
    borderColor: Colors.gray300,
    backgroundColor: Colors.gray100,
  },
  stepText: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.primaryDark,
    lineHeight: 24,
  },
  stepTextDisabled: {
    color: Colors.gray400,
  },
  valuePill: {
    minWidth: 96,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  value: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.gray900,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
});
