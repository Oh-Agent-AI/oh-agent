//! Shared vocabulary. Stats table is GDD §3.1.

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MechId {
    Assault,
    Gunner,
    Support,
}

impl MechId {
    pub const ALL: [MechId; 3] = [MechId::Assault, MechId::Gunner, MechId::Support];

    pub fn as_str(self) -> &'static str {
        match self {
            MechId::Assault => "Assault",
            MechId::Gunner => "Gunner",
            MechId::Support => "Support",
        }
    }

    pub fn stats(self) -> MechStats {
        match self {
            MechId::Assault => MechStats {
                max_hp: 14,
                move_range: 4,
                atk: 5,
                def: 2,
                shoot_range: 0,
                melee: true,
            },
            MechId::Gunner => MechStats {
                max_hp: 11,
                move_range: 3,
                atk: 4,
                def: 1,
                shoot_range: 4,
                melee: false,
            },
            MechId::Support => MechStats {
                max_hp: 12,
                move_range: 3,
                atk: 2,
                def: 2,
                shoot_range: 3,
                melee: true,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MechStats {
    pub max_hp: u16,
    pub move_range: u8,
    pub atk: i16,
    pub def: i16,
    pub shoot_range: u8,
    pub melee: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnitId {
    Mech(MechId),
    Boss,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BossScript {
    StationarySmash,
    CadenceSsw,
    Mcp,
}

impl BossScript {
    pub fn id(self) -> &'static str {
        match self {
            BossScript::StationarySmash => "stationary_smash",
            BossScript::CadenceSsw => "cadence_ssw",
            BossScript::Mcp => "mcp",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BossSkill {
    Smash,
    Sweep,
    Skip,
}

impl BossSkill {
    pub fn id(self) -> &'static str {
        match self {
            BossSkill::Smash => "smash",
            BossSkill::Sweep => "sweep",
            BossSkill::Skip => "skip",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Facing {
    N,
    E,
    S,
    W,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Skip,
    Melee { target: UnitId },
    Shoot { target: UnitId },
    /// Assault 冲撞: melee damage +2, knockback still 1.
    Charge,
    /// Gunner 穿射: this shot ignores 1 cover cell.
    Pierce { target: UnitId },
    /// Support 维修: adjacent ally +4 HP.
    Repair { target: MechId },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Victory,
    DefeatWipe,
    DefeatTimeout,
}
