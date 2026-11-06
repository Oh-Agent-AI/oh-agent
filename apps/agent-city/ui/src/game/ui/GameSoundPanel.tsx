import { gameText, type GameLocale } from "../gameCopy";

export type GameSoundCapabilities = Readonly<{
  volume: number; onVolume: (value: number) => void;
  sfx?: Readonly<{ enabled: boolean; onToggle: () => void }>;
  music?: Readonly<{ enabled: boolean; onToggle: () => void }>;
}>;
export function GameSoundPanel({ locale, sound, onOpenChange }: { locale: GameLocale; sound: GameSoundCapabilities; onOpenChange?: (open: boolean) => void }) {
  const t = (text: string) => gameText(text, locale);
  return <details className="city-game-chip city-game-sound" onToggle={(event) => onOpenChange?.((event.currentTarget as HTMLDetailsElement).open)}>
    <summary aria-label={t("游戏声音")}>♪ {t("声音")}</summary>
    <div className="city-game-sound-panel">
      <label>{t("音量")}<input type="range" min="0" max="100" step="1" value={Math.round(sound.volume * 100)}
        onChange={(event) => sound.onVolume(Number(event.currentTarget.value) / 100)} aria-label={t("游戏声音大小")} /></label>
      {(sound.sfx || sound.music) && <div className="city-game-sound-toggles">
        {sound.sfx && <button type="button" aria-pressed={sound.sfx.enabled} onClick={sound.sfx.onToggle}>{t("音效")} · {t(sound.sfx.enabled ? "开" : "关")}</button>}
        {sound.music && <button type="button" aria-pressed={sound.music.enabled} onClick={sound.music.onToggle}>BGM · {t(sound.music.enabled ? "开" : "关")}</button>}
      </div>}
    </div>
  </details>;
}
