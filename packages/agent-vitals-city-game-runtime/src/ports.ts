/** Browser/app ports injected into a game runtime. The SDK deliberately does
 * not import Three.js, React, DOM or CityEngine; hosts provide these ports. */
export type GameScenePortV1 = Readonly<{
  revision: string;
  attach: (root: unknown) => void;
  detach: (root: unknown) => void;
}>;

export type GameInputPortV1 = Readonly<{
  /** Latest normalized input; runtimes poll once per fixed step. */
  read: () => Readonly<Record<string, number | boolean>>;
}>;

export type GameAudioPortV1 = Readonly<{
  play: (id: string, options?: Readonly<{ volume?: number; loop?: boolean }>) => void;
  stop: (id: string) => void;
}>;

export type GameClockPortV1 = Readonly<{
  nowMs: () => number;
  fixedDtSeconds: number;
}>;

export type GameActivityPortV1 = Readonly<{
  activityId: string;
  release: () => void;
}>;
