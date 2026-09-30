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

  return (
    <View style={s.row}>
      <Text style={s.label}>Making Time</Text>
      <View style={s.stepper}>
        <Pressable
          testID="prep-minus"
          style={[s.stepBtn, value <= PREP_MIN_MINUTES && s.stepBtnDisabled]}
          disabled={value <= PREP_MIN_MINUTES}
          onPress={() => step(-1)}>
          <Text style={[s.stepText, value <= PREP_MIN_MINUTES && s.stepTextDisabled]}>
            −
          </Text>
        </Pressable>
        <Text style={s.value} testID="prep-minutes">
          {value} min
        </Text>
        <Pressable
          testID="prep-plus"
          style={[s.stepBtn, value >= PREP_MAX_MINUTES && s.stepBtnDisabled]}
          disabled={value >= PREP_MAX_MINUTES}
          onPress={() => step(1)}>
          <Text style={[s.stepText, value >= PREP_MAX_MINUTES && s.stepTextDisabled]}>
            +
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
    paddingHorizontal: 2,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.gray700,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stepBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
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
  value: {
    minWidth: 64,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '700',
    color: Colors.gray900,
    fontVariant: ['tabular-nums'],
  },
});
