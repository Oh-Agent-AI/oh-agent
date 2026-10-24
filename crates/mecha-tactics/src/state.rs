//! Match state, `match_seed`, occupancy, boss intent.

use std::collections::BTreeSet;

use crate::covers::CoverPreset;
use crate::geom::{adjacent_to_footprint, footprint, occupies_footprint, Cell};
use crate::types::{BossScript, BossSkill, Facing, MechId, Outcome};
use crate::{BOARD_H, BOARD_W, BOSS_HP, GDD_RULESET};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    EnemyPrepare,
    PlayerPlan,
    ResolvingBoss,
    Finished,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Occupant {
    Empty,
    Cover,
    Mech(MechId),
    Boss,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentStatus {
    Planned,
    Reprojected,
    Void,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BossIntent {
    pub skill_id: BossSkill,
    pub local_cells: Vec<crate::geom::Offset>,
    pub facing: Option<Facing>,
    pub cd_sweep: u8,
    pub projected_cells: Vec<Cell>,
    pub status: IntentStatus,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MechState {
    pub id: MechId,
    pub pos: Cell,
    pub hp: u16,
    pub cd_skill: u8,
    skill_used_this_phase: bool,
}

impl MechState {
    pub fn alive(&self) -> bool {
        self.hp > 0
    }

    pub fn max_hp(&self) -> u16 {
        self.id.stats().max_hp
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BossState {
    pub anchor: Cell,
    pub hp: u16,
    pub cd_sweep: u8,
    /// 0,1 smash beats; 2 sweep beat of `cadence_ssw`.
    pub cadence_step: u8,
    pub intent: Option<BossIntent>,
}

impl BossState {
    pub fn alive(&self) -> bool {
        self.hp > 0
    }

    pub fn footprint(&self) -> [Cell; 4] {
        footprint(self.anchor)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoardSpec {
    pub w: i8,
    pub h: i8,
    pub covers: Vec<Cell>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeploySpec {
    pub mechs: Vec<(MechId, Cell)>,
    pub boss: Cell,
}

impl DeploySpec {
    pub fn standard() -> Self {
        DeploySpec {
            mechs: vec![
                (MechId::Assault, Cell::new(2, 9)),
                (MechId::Gunner, Cell::new(5, 9)),
                (MechId::Support, Cell::new(8, 9)),
            ],
            boss: Cell::new(4, 0),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchSeed {
    pub seed_u64: u64,
    pub gdd_ruleset: &'static str,
    pub board: BoardSpec,
    pub cover_preset: CoverPreset,
    pub deploy: DeploySpec,
    pub boss_script: BossScript,
}

impl MatchSeed {
    pub fn new(seed_u64: u64, preset: CoverPreset, script: BossScript) -> Self {
        MatchSeed {
            seed_u64,
            gdd_ruleset: GDD_RULESET,
            board: BoardSpec {
                w: BOARD_W,
                h: BOARD_H,
                covers: preset.cells().to_vec(),
            },
            cover_preset: preset,
            deploy: DeploySpec::standard(),
            boss_script: script,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Match {
    seed: MatchSeed,
    covers: BTreeSet<Cell>,
    mechs: [Option<MechState>; 3],
    boss: BossState,
    turn: u8,
    phase: Phase,
    revision: u64,
    outcome: Option<Outcome>,
}

impl Match {
    pub fn from_seed(seed: MatchSeed) -> Self {
        let covers: BTreeSet<Cell> = seed.board.covers.iter().copied().collect();
        let mut mechs = [None, None, None];
        for (id, pos) in &seed.deploy.mechs {
            let idx = mech_index(*id);
            mechs[idx] = Some(MechState {
                id: *id,
                pos: *pos,
                hp: id.stats().max_hp,
                cd_skill: 0,
                skill_used_this_phase: false,
            });
        }
        Match {
            boss: BossState {
                anchor: seed.deploy.boss,
                hp: BOSS_HP,
                cd_sweep: 0,
                cadence_step: 0,
                intent: None,
            },
            seed,
            covers,
            mechs,
            turn: 1,
            phase: Phase::EnemyPrepare,
            revision: 0,
            outcome: None,
        }
    }

    pub fn seed(&self) -> &MatchSeed {
        &self.seed
    }
    pub fn turn(&self) -> u8 {
        self.turn
    }
    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn outcome(&self) -> Option<Outcome> {
        self.outcome
    }
    pub fn boss(&self) -> &BossState {
        &self.boss
    }
    pub fn covers_iter(&self) -> impl Iterator<Item = Cell> + '_ {
        self.covers.iter().copied()
    }
    pub fn is_cover(&self, c: Cell) -> bool {
        self.covers.contains(&c)
    }

    pub fn mech(&self, id: MechId) -> Option<&MechState> {
        self.mechs[mech_index(id)].as_ref().filter(|m| m.alive())
    }

    pub fn mech_even_dead(&self, id: MechId) -> Option<&MechState> {
        self.mechs[mech_index(id)].as_ref()
    }

    pub fn living_ids(&self) -> Vec<MechId> {
        MechId::ALL
            .iter()
            .copied()
            .filter(|id| self.mech(*id).is_some())
            .collect()
    }

    pub fn all_mechs_dead(&self) -> bool {
        self.living_ids().is_empty()
    }

    pub fn boss_dead(&self) -> bool {
        !self.boss.alive()
    }

    pub fn occupant(&self, c: Cell) -> Occupant {
        if !c.in_bounds() {
            return Occupant::Empty;
        }
        if self.boss.alive() && occupies_footprint(self.boss.anchor, c) {
            return Occupant::Boss;
        }
        for id in MechId::ALL {
            if let Some(m) = self.mech(id) {
                if m.pos == c {
                    return Occupant::Mech(id);
                }
            }
        }
        if self.covers.contains(&c) {
            Occupant::Cover
        } else {
            Occupant::Empty
        }
    }

    pub fn blocked_for_move(&self, c: Cell) -> bool {
        if !c.in_bounds() {
            return true;
        }
        !matches!(self.occupant(c), Occupant::Empty)
    }

    pub fn intent(&self) -> Option<&BossIntent> {
        self.boss.intent.as_ref()
    }

    pub fn projected_cells(&self) -> &[Cell] {
        self.boss
            .intent
            .as_ref()
            .map(|i| i.projected_cells.as_slice())
            .unwrap_or(&[])
    }

    pub fn is_telegraph(&self, c: Cell) -> bool {
        self.projected_cells().contains(&c)
    }

    pub fn adjacent_to_boss(&self, c: Cell) -> bool {
        self.boss.alive() && adjacent_to_footprint(self.boss.anchor, c)
    }

    pub(crate) fn mech_mut(&mut self, id: MechId) -> Option<&mut MechState> {
        self.mechs[mech_index(id)].as_mut()
    }

    pub(crate) fn boss_mut(&mut self) -> &mut BossState {
        &mut self.boss
    }

    pub(crate) fn set_phase(&mut self, p: Phase) {
        self.phase = p;
    }

    pub(crate) fn bump_revision(&mut self) {
        self.revision += 1;
    }

    pub(crate) fn set_turn(&mut self, t: u8) {
        self.turn = t;
    }

    pub(crate) fn set_outcome(&mut self, o: Outcome) {
        self.outcome = Some(o);
        self.phase = Phase::Finished;
    }

    pub(crate) fn refresh_outcome(&mut self) {
        if self.outcome.is_none() {
            if self.boss_dead() {
                self.set_outcome(Outcome::Victory);
            } else if self.all_mechs_dead() {
                self.set_outcome(Outcome::DefeatWipe);
            }
        }
        // validate_and_apply_plan stamps ResolvingBoss after a killing action
        // already stored the outcome. City never executes a dead boss, so a
        // stale ResolvingBoss would leave the match mid-resolution.
        if self.outcome.is_some() {
            self.phase = Phase::Finished;
        }
    }

    pub fn void_intent(&mut self) {
        if let Some(intent) = self.boss.intent.as_mut() {
            intent.status = IntentStatus::Void;
            intent.projected_cells.clear();
        }
    }

    pub fn reproject_intent(&mut self) {
        let Some(intent) = self.boss.intent.as_mut() else {
            return;
        };
        if matches!(intent.skill_id, BossSkill::Skip) {
            return;
        }
        let anchor = self.boss.anchor;
        let mut projected = Vec::new();
        for off in &intent.local_cells {
            let c = anchor.offset(*off);
            if c.in_bounds() {
                projected.push(c);
            }
        }
        if projected.is_empty() {
            intent.status = IntentStatus::Void;
            intent.projected_cells.clear();
        } else {
            intent.projected_cells = projected;
            intent.status = IntentStatus::Reprojected;
        }
    }

    /// Test helper: force cadence / CD so fallback can be asserted via public ticks.
    pub fn set_script_counters(&mut self, cadence_step: u8, cd_sweep: u8) {
        self.boss.cadence_step = cadence_step % 3;
        self.boss.cd_sweep = cd_sweep;
    }

    pub(crate) fn mark_skill_used(&mut self, id: MechId) {
        if let Some(m) = self.mech_mut(id) {
            m.skill_used_this_phase = true;
            m.cd_skill = 1;
        }
    }

    pub(crate) fn tick_mech_skill_cds(&mut self) {
        for slot in &mut self.mechs {
            if let Some(m) = slot.as_mut() {
                if m.skill_used_this_phase {
                    m.skill_used_this_phase = false;
                } else if m.cd_skill > 0 {
                    m.cd_skill -= 1;
                }
            }
        }
    }

    pub(crate) fn set_mech_pos(&mut self, id: MechId, pos: Cell) {
        if let Some(m) = self.mech_mut(id) {
            m.pos = pos;
        }
    }
}

pub(crate) fn mech_index(id: MechId) -> usize {
    match id {
        MechId::Assault => 0,
        MechId::Gunner => 1,
        MechId::Support => 2,
    }
}
