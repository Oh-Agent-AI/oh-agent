//! Pure GDD v1.3 mecha-tactics rules engine.
//!
//! Combat Fun Validation only: headless board, `arena_plan` whole-pack
//! apply, scripted Boss (`stationary_smash` / `cadence_ssw`), and three
//! strategy adapters. No City / MCP / 3D / HUD.

#![forbid(unsafe_code)]

pub const GDD_RULESET: &str = "mecha-v1.3";
pub const BOARD_W: i8 = 10;
pub const BOARD_H: i8 = 10;
pub const MAX_TURNS: u8 = 15;
pub const BOSS_HP: u16 = 40;
pub const BOSS_ATK: i16 = 6;
pub const BOSS_DEF: i16 = 3;
pub const BOSS_MOVE: u8 = 3;
pub const COLLISION_DAMAGE: u16 = 2;
pub const REPAIR_AMOUNT: u16 = 4;

mod combat;
mod covers;
mod geom;
mod plan;
mod scripts;
mod sim;
mod state;
mod strategy;
mod types;

pub use covers::{CoverPreset, COVERS_DIAG_CORRIDOR, COVERS_SPARSE_MID, COVERS_TWIN_CLUSTERS};
pub use geom::{
    attacker_center, chebyshev, footprint, footprint_center, knockback_dir_from_attacker,
    knockback_dir_from_boss, manhattan, primary_axis, Cell, Dir, Offset,
};
pub use plan::{validate_and_apply_plan, ArenaPlan, MechOrder, PlanOk, PlanReject, RejectCode};
pub use scripts::{boss_script_tick_execute, boss_script_tick_prepare, ExecuteReport};
pub use sim::{
    run_fun_validation, run_match, FunValidationConfig, FunValidationReport, MatchResult,
    ComboStats,
};
pub use state::{
    BoardSpec, BossIntent, BossState, DeploySpec, IntentStatus, Match, MatchSeed, MechState,
    Occupant, Phase,
};
pub use strategy::{PlayerStrategy, StrategyKind};
pub use types::{
    Action, BossScript, BossSkill, Facing, MechId, MechStats, Outcome, UnitId,
};

pub fn hold_plan(m: &Match) -> ArenaPlan {
    ArenaPlan {
        revision: Some(m.revision()),
        items: m
            .living_ids()
            .into_iter()
            .map(|mech_id| MechOrder {
                mech_id,
                move_to: None,
                action: Action::Skip,
            })
            .collect(),
    }
}
