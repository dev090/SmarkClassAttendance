import type { EffectiveState } from '../types';

const LABEL: Record<EffectiveState, string> = {
  present: 'Present',
  detected: 'Detected…',
  away: 'Away',
  left: 'Left',
  unknown: 'Not detected',
  absent: 'Absent',
  excused: 'Excused',
};
const ICON: Record<EffectiveState, string> = { present: '✓', detected: '…', away: '◔', left: '↗', unknown: '—', absent: '✕', excused: '≋' };

export function StateBadge({ state, manual }: { state: EffectiveState; manual?: boolean }) {
  return (
    <span className={`badge ${state}`} title={manual ? 'Set manually by the professor' : undefined}>
      <i aria-hidden />
      <span aria-hidden>{ICON[state]}</span>
      {LABEL[state]}
      {manual ? ' (manual)' : ''}
    </span>
  );
}

export const STATE_ORDER: Record<EffectiveState, number> = { present: 0, detected: 1, away: 2, left: 3, excused: 4, unknown: 5, absent: 5 };
