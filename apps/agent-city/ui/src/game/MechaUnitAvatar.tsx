import { useState } from "react";
import type { MechId } from "./mecha/rules";
import type { GameLocale } from "./gameCopy";
import { describeUnitIdentity } from "./mecha/unitIdentity";
import { getUnitPortrait } from "./mecha/unitPortraits";

export type MechaUnitPortraitProps = {
  unitId: string;
  locale?: GameLocale;
  size?: number;
  className?: string;
  /** Decorative by default; set false to expose a localized, labeled image. */
  decorative?: boolean;
  ariaLabel?: string;
};

export type MechaUnitAvatarProps = Omit<MechaUnitPortraitProps, "unitId"> & {
  mechId: MechId;
};

function PortraitImage({
  unitId,
  locale = "zh-Hans",
  size = 28,
  className,
  decorative = true,
  ariaLabel,
}: MechaUnitPortraitProps) {
  const [failed, setFailed] = useState(false);
  const identity = describeUnitIdentity(unitId, locale);
  const portrait = getUnitPortrait(unitId);
  const showImage = portrait !== null && !failed;
  const label = ariaLabel ?? identity.label;
  const fallbackReason = portrait === null
    ? (locale === "en" ? "Unknown identity" : "身份未知")
    : (locale === "en" ? "Portrait unavailable" : "头像不可用");
  const accessibleProps = decorative
    ? { "aria-hidden": true as const }
    : { role: "img" as const, "aria-label": showImage ? label : `${label} — ${fallbackReason}` };

  return (
    <span
      className={className}
      data-unit-id={unitId}
      data-portrait-key={portrait?.key}
      data-portrait-state={showImage ? "image" : portrait ? "unavailable" : "unknown"}
      style={{
        display: "inline-flex", width: size, height: size, flexShrink: 0,
        alignItems: "center", justifyContent: "center", verticalAlign: "middle",
        overflow: "hidden",
      }}
      {...accessibleProps}
    >
      {showImage ? (
        <img
          src={portrait.src}
          width={size}
          height={size}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          style={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }}
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true" style={{ fontSize: size * 0.65, lineHeight: 1 }}>
          {identity.symbol}
        </span>
      )}
    </span>
  );
}

/** Cropped existing concept art for mechs/enemies; no synthesized or guessed portrait. */
export function MechaUnitPortrait(props: MechaUnitPortraitProps) {
  // A new identity starts a fresh load even if the preceding unit's image failed.
  return <PortraitImage key={props.unitId} {...props} />;
}

/** Backward-compatible player-mech API, now backed by the original character art. */
export function MechaUnitAvatar({ mechId, ...props }: MechaUnitAvatarProps) {
  return <MechaUnitPortrait unitId={mechId} {...props} />;
}
