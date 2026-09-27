export const COMBAT_STEP_MS = 100;
export const BASE_ACTION_INTERVAL_MS = 1000;
export const MIN_MONSTER_ACTION_INTERVAL_MS = 300;
export const STATUS_PULSE_MS = 1000;
export const STUN_MS = 1000;
export const SCORCH_MS = 2000;
export const MIN_COOLDOWN_MS = 1000;
export const INTERRUPT_DELAY_MS = 300;
export const RUN_AVAILABLE_MS = 5000;
export const KILL_BEAT_MS = 800;
/** Players' first action lands at this offset + 100 ms × sorted index (index capped at 5). */
export const FIRST_ACTION_PLAYER_MS = 1000;
/** Monsters' first action lands at this offset + 100 ms × sorted index (index capped at 8). */
export const FIRST_ACTION_MONSTER_MS = 1400;
export const STALEMATE_WINDOW_MS = 30000;
/** Stalemate window while a living boss/raid monster is in the fight. */
export const BOSS_STALEMATE_WINDOW_MS = 180000;
export const LOW_HP_THRESHOLD = 0.5;
/** Heal/HoT options are needed while a living ally is below this HP fraction. */
export const HEAL_NEEDED_THRESHOLD = 0.7;
/** Server batches combat messages per party at this cadence. */
export const COMBAT_SEND_MS = 200;
/** Dynamic snapshot cadence inside combat messages. */
export const COMBAT_SNAPSHOT_MS = 500;
/** Client render delay behind server time. */
export const PLAYBACK_DELAY_MS = 300;
/** Journal entries carried in each state message. */
export const STATE_LOG_TAIL = 100;
