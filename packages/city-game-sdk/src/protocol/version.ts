/**
 * One package, one protocol major. The manifest pins `apiMajor`; the host
 * rejects anything else instead of guessing compatibility. A breaking API
 * change bumps this constant and the manifest field together — never one half.
 */
export const CITY_GAME_SDK_PACKAGE = "@oh-agent/city-game-sdk";
export const CITY_GAME_SDK_API_MAJOR = 1;
export const CODE_GAME_MANIFEST_SCHEMA_VERSION = 1;
export const CODE_GAME_KIND = "code-game";
