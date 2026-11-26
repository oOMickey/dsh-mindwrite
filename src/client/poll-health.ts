export interface PollHealth {
  failures: number;
  message: string;
  dismissed: boolean;
}
export const healthy: PollHealth = { failures: 0, message: '', dismissed: false };
export function pollFailed(state: PollHealth, message: string): PollHealth {
  return {
    failures: state.failures + 1,
    message,
    dismissed: state.message === message && state.dismissed,
  };
}
export const retryDelay = (state: PollHealth) =>
  Math.min(8000, 800 * 2 ** Math.min(4, state.failures));
