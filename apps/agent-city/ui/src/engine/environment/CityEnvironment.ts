/** The host's one environment timeline, shared by all vehicles and render effects.
 * Sampling is explicit and deterministic; no Date.now(), timers or Three objects.
 * Geometry freezes do not freeze weather. Cinematics explicitly select clear sky. */
import { weatherAt, type WeatherState } from "./WeatherState";
export type CityEnvironmentSnapshot = Readonly<{
  timestampMs: number;
  mode: "world" | "cinematic";
  hour: number;
  weather: Readonly<WeatherState>;
  rainIntensity: number;
  timeZone: Readonly<{ policy: "host-local" | "fixed-offset"; utcOffsetMinutes: number }>;
}>;
export type CityEnvironmentOptions = Readonly<{ utcOffsetMinutes?: number }>;
export class CityEnvironment {
  private cached: CityEnvironmentSnapshot | null = null;
  constructor(private readonly options: CityEnvironmentOptions = {}) {
    if (options.utcOffsetMinutes !== undefined && (!Number.isInteger(options.utcOffsetMinutes) || Math.abs(options.utcOffsetMinutes) > 840)) throw new Error("invalid-environment-offset");
    this.options = Object.freeze({ ...options });
  }
  sample(timestampMs: number, cinematicHour?: number): CityEnvironmentSnapshot {
    if (!Number.isFinite(timestampMs) || cinematicHour !== undefined && !Number.isFinite(cinematicHour)) throw new Error("invalid-environment-time");
    // Stable half-second slots keep audio and visuals on the same weather sample.
    const time = Math.floor(timestampMs / 500) * 500;
    const mode = cinematicHour === undefined ? "world" : "cinematic";
    const offset = this.options.utcOffsetMinutes ?? -new Date(time).getTimezoneOffset();
    const cached = this.cached;
    if (cached?.timestampMs === time && cached.timeZone.utcOffsetMinutes === offset && cached.mode === mode && (mode === "world" || cached.hour === cinematicHour)) return cached;
    const date = new Date(time + offset * 60_000);
    const hour = cinematicHour ?? date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    const weather = Object.freeze(mode === "cinematic" ? { kind: "clear" as const, intensity: 0, rainbow: 0, overcast: 0 } : weatherAt(time, offset));
    return this.cached = Object.freeze({ timestampMs: time, mode, hour, weather,
      rainIntensity: weather.kind === "rain" ? weather.intensity : 0,
      timeZone: Object.freeze({ policy: this.options.utcOffsetMinutes === undefined ? "host-local" : "fixed-offset", utcOffsetMinutes: offset }) });
  }
}
