//! `arena_plan`: one three-mech pack, whole-pack validate, whole-pack rollback.

use std::collections::{HashSet, VecDeque};

use crate::combat::{apply_repair, resolve_melee_on_boss, resolve_ranged_on_boss};
use crate::geom::{adjacent_to_footprint, chebyshev, Cell, Dir};
use crate::state::{Match, Occupant, Phase};
use crate::types::{Action, MechId, UnitId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RejectCode {
    OutOfRange,
    BlockedPath,
    OrderOccupied,
    NeedAllOrConfirm,
    StaleRevision,
    BossIntentIllegal,
    PlanPackRejected,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanReject {
    pub code: RejectCode,
    pub reason: String,
    pub mech_id: Option<MechId>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanOk {
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MechOrder {
    pub mech_id: MechId,
    pub move_to: Option<Cell>,
    pub action: Action,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArenaPlan {
    pub revision: Option<u64>,
    pub items: Vec<MechOrder>,
}

/// Whole-pack apply. Any illegal order rolls the pack back; the live
/// match is left on the same revision so the caller may resubmit.
pub fn validate_and_apply_plan(m: &mut Match, plan: &ArenaPlan) -> Result<PlanOk, PlanReject> {
    if m.phase() != Phase::PlayerPlan {
        return Err(PlanReject {
            code: RejectCode::PlanPackRejected,
            reason: format!("phase {:?} is not player_plan", m.phase()),
            mech_id: None,
        });
    }
    if let Some(rev) = plan.revision {
        if rev != m.revision() {
            return Err(PlanReject {
                code: RejectCode::StaleRevision,
                reason: "plan revision does not match host".to_string(),
                mech_id: None,
            });
        }
    }
    let living = m.living_ids();
    let mut seen = HashSet::new();
    for item in &plan.items {
        if !seen.insert(item.mech_id) {
            return Err(pack_need_all("duplicate mech in pack"));
        }
    }
    if seen.len() != living.len() || living.iter().any(|id| !seen.contains(id)) {
        return Err(pack_need_all("pack must name every living mech exactly once"));
    }

    let mut trial = m.clone();
    for item in &plan.items {
        apply_one(&mut trial, item)?;
    }
    trial.tick_mech_skill_cds();
    trial.bump_revision();
    trial.set_phase(Phase::ResolvingBoss);
    trial.refresh_outcome();
    *m = trial;
    Ok(PlanOk {
        revision: m.revision(),
    })
}

fn pack_need_all(reason: &str) -> PlanReject {
    PlanReject {
        code: RejectCode::NeedAllOrConfirm,
        reason: reason.to_string(),
        mech_id: None,
    }
}

fn pack_err(code: RejectCode, mech_id: MechId, reason: &str) -> PlanReject {
    PlanReject {
        code: RejectCode::PlanPackRejected,
        reason: format!("{:?}: {}", code, reason),
        mech_id: Some(mech_id),
    }
}

fn apply_one(m: &mut Match, item: &MechOrder) -> Result<(), PlanReject> {
    let id = item.mech_id;
    let Some(mech) = m.mech(id) else {
        return Err(pack_err(
            RejectCode::NeedAllOrConfirm,
            id,
            "mech is not alive",
        ));
    };
    let origin = mech.pos;
    let dest = item.move_to.unwrap_or(origin);
    if dest != origin {
        match path_distance(m, origin, dest, id) {
            None => {
                if m.blocked_for_move(dest) && dest != origin {
                    return Err(pack_err(
                        RejectCode::OrderOccupied,
                        id,
                        "destination occupied",
                    ));
                }
                return Err(pack_err(
                    RejectCode::BlockedPath,
                    id,
                    "no path within move range",
                ));
            }
            Some(dist) => {
                if dist > id.stats().move_range {
                    return Err(pack_err(
                        RejectCode::OutOfRange,
                        id,
                        "move exceeds move_range",
                    ));
                }
            }
        }
        m.set_mech_pos(id, dest);
    }
    apply_action(m, id, item.action)
}

fn apply_action(m: &mut Match, id: MechId, action: Action) -> Result<(), PlanReject> {
    let stats = id.stats();
    let Some(mech) = m.mech(id) else {
        return Err(pack_err(RejectCode::NeedAllOrConfirm, id, "mech died before acting"));
    };
    let from = mech.pos;
    let cd = mech.cd_skill;
    match action {
        Action::Skip => Ok(()),
        Action::Melee { target } => {
            if !stats.melee {
                return Err(pack_err(RejectCode::OutOfRange, id, "this mech has no melee"));
            }
            require_melee_target(m, id, from, target)?;
            match target {
                UnitId::Boss => resolve_melee_on_boss(m, id, 0),
                UnitId::Mech(_) => {
                    return Err(pack_err(
                        RejectCode::BossIntentIllegal,
                        id,
                        "friendly fire is not a v1 action",
                    ));
                }
            }
            Ok(())
        }
        Action::Charge => {
            if id != MechId::Assault {
                return Err(pack_err(RejectCode::OutOfRange, id, "charge is Assault-only"));
            }
            if cd != 0 {
                return Err(pack_err(RejectCode::OutOfRange, id, "skill on cooldown"));
            }
            require_melee_target(m, id, from, UnitId::Boss)?;
            resolve_melee_on_boss(m, id, 2);
            m.mark_skill_used(id);
            Ok(())
        }
        Action::Shoot { target } => {
            if stats.shoot_range == 0 {
                return Err(pack_err(RejectCode::OutOfRange, id, "this mech has no shot"));
            }
            require_shot(m, from, target, stats.shoot_range, 0, id)?;
            resolve_shot(m, id, target);
            Ok(())
        }
        Action::Pierce { target } => {
            if id != MechId::Gunner {
                return Err(pack_err(RejectCode::OutOfRange, id, "pierce is Gunner-only"));
            }
            if cd != 0 {
                return Err(pack_err(RejectCode::OutOfRange, id, "skill on cooldown"));
            }
            require_shot(m, from, target, stats.shoot_range, 1, id)?;
            resolve_shot(m, id, target);
            m.mark_skill_used(id);
            Ok(())
        }
        Action::Repair { target } => {
            if id != MechId::Support {
                return Err(pack_err(RejectCode::OutOfRange, id, "repair is Support-only"));
            }
            if cd != 0 {
                return Err(pack_err(RejectCode::OutOfRange, id, "skill on cooldown"));
            }
            if target == id {
                return Err(pack_err(RejectCode::OutOfRange, id, "cannot repair self"));
            }
            let Some(ally) = m.mech(target) else {
                return Err(pack_err(RejectCode::OutOfRange, id, "repair target not alive"));
            };
            if chebyshev(from, ally.pos) != 1 {
                return Err(pack_err(RejectCode::OutOfRange, id, "repair target not adjacent"));
            }
            apply_repair(m, target);
            m.mark_skill_used(id);
            Ok(())
        }
    }
}

fn require_melee_target(
    m: &Match,
    id: MechId,
    from: Cell,
    target: UnitId,
) -> Result<(), PlanReject> {
    match target {
        UnitId::Boss => {
            if !m.boss().alive() {
                return Err(pack_err(RejectCode::OutOfRange, id, "boss is dead"));
            }
            if !adjacent_to_footprint(m.boss().anchor, from) {
                return Err(pack_err(RejectCode::OutOfRange, id, "not adjacent to boss"));
            }
            Ok(())
        }
        UnitId::Mech(other) => {
            let Some(t) = m.mech(other) else {
                return Err(pack_err(RejectCode::OutOfRange, id, "melee target missing"));
            };
            if chebyshev(from, t.pos) != 1 {
                return Err(pack_err(RejectCode::OutOfRange, id, "melee target not adjacent"));
            }
            Ok(())
        }
    }
}

fn require_shot(
    m: &Match,
    from: Cell,
    target: UnitId,
    range: u8,
    ignore_covers: u8,
    id: MechId,
) -> Result<(), PlanReject> {
    let aim = shot_aim_cell(m, from, target).ok_or_else(|| {
        pack_err(RejectCode::OutOfRange, id, "shot not aligned with target")
    })?;
    let dist = chebyshev(from, aim);
    if dist < 1 || dist as u8 > range {
        return Err(pack_err(RejectCode::OutOfRange, id, "shot out of range"));
    }
    if !los_clear(m, from, aim, ignore_covers) {
        return Err(pack_err(RejectCode::BlockedPath, id, "line of fire blocked"));
    }
    Ok(())
}

fn shot_aim_cell(m: &Match, from: Cell, target: UnitId) -> Option<Cell> {
    match target {
        UnitId::Mech(id) => {
            let t = m.mech(id)?;
            if t.pos.x == from.x || t.pos.y == from.y {
                Some(t.pos)
            } else {
                None
            }
        }
        UnitId::Boss => {
            if !m.boss().alive() {
                return None;
            }
            let mut best: Option<(i8, Cell)> = None;
            for c in m.boss().footprint() {
                if c.x == from.x || c.y == from.y {
                    let d = chebyshev(from, c);
                    if best.map(|(bd, _)| d < bd).unwrap_or(true) {
                        best = Some((d, c));
                    }
                }
            }
            best.map(|(_, c)| c)
        }
    }
}

fn los_clear(m: &Match, from: Cell, to: Cell, ignore_covers: u8) -> bool {
    let Some(between) = cells_between(from, to) else {
        return false;
    };
    let mut covers = 0u8;
    for c in between {
        match m.occupant(c) {
            Occupant::Cover => {
                covers = covers.saturating_add(1);
                if covers > ignore_covers {
                    return false;
                }
            }
            Occupant::Empty => {}
            Occupant::Mech(_) | Occupant::Boss => {
                if c != to {
                    return false;
                }
            }
        }
    }
    true
}

fn cells_between(from: Cell, to: Cell) -> Option<Vec<Cell>> {
    if from.x == to.x {
        let (a, b) = if from.y < to.y {
            (from.y + 1, to.y)
        } else {
            (to.y + 1, from.y)
        };
        let mut v = Vec::new();
        let mut y = a;
        while y < b {
            v.push(Cell::new(from.x, y));
            y += 1;
        }
        Some(v)
    } else if from.y == to.y {
        let (a, b) = if from.x < to.x {
            (from.x + 1, to.x)
        } else {
            (to.x + 1, from.x)
        };
        let mut v = Vec::new();
        let mut x = a;
        while x < b {
            v.push(Cell::new(x, from.y));
            x += 1;
        }
        Some(v)
    } else {
        None
    }
}

fn resolve_shot(m: &mut Match, id: MechId, target: UnitId) {
    match target {
        UnitId::Boss => resolve_ranged_on_boss(m, id),
        UnitId::Mech(_) => {}
    }
}

/// 4-dir BFS. `mover` may pass through its own origin.
pub fn path_distance(m: &Match, from: Cell, to: Cell, mover: MechId) -> Option<u8> {
    if from == to {
        return Some(0);
    }
    if !to.in_bounds() {
        return None;
    }
    match m.occupant(to) {
        Occupant::Empty => {}
        Occupant::Mech(id) if id == mover => {}
        _ => return None,
    }
    let mut dist = [[-1i16; 10]; 10];
    let mut q = VecDeque::new();
    dist[from.y as usize][from.x as usize] = 0;
    q.push_back(from);
    while let Some(cur) = q.pop_front() {
        let d = dist[cur.y as usize][cur.x as usize];
        for dir in Dir::CARDINALS {
            let nxt = cur.translate(dir);
            if !nxt.in_bounds() {
                continue;
            }
            if dist[nxt.y as usize][nxt.x as usize] >= 0 {
                continue;
            }
            let passable = match m.occupant(nxt) {
                Occupant::Empty => true,
                Occupant::Mech(id) if id == mover => true,
                _ => nxt == to && matches!(m.occupant(to), Occupant::Empty),
            };
            if !passable {
                continue;
            }
            dist[nxt.y as usize][nxt.x as usize] = d + 1;
            if nxt == to {
                return Some((d + 1) as u8);
            }
            q.push_back(nxt);
        }
    }
    None
}

pub fn legal_destinations(m: &Match, id: MechId) -> Vec<Cell> {
    let Some(mech) = m.mech(id) else {
        return Vec::new();
    };
    let range = id.stats().move_range;
    let mut out = Vec::new();
    for y in 0..10i8 {
        for x in 0..10i8 {
            let c = Cell::new(x, y);
            if let Some(d) = path_distance(m, mech.pos, c, id) {
                if d <= range {
                    out.push(c);
                }
            }
        }
    }
    out.sort();
    out
}

pub fn legal_actions(m: &Match, id: MechId) -> Vec<Action> {
    let Some(mech) = m.mech(id) else {
        return vec![Action::Skip];
    };
    let from = mech.pos;
    let stats = id.stats();
    let mut out = vec![Action::Skip];
    if stats.melee && m.boss().alive() && adjacent_to_footprint(m.boss().anchor, from) {
        out.push(Action::Melee {
            target: UnitId::Boss,
        });
        if id == MechId::Assault && mech.cd_skill == 0 {
            out.push(Action::Charge);
        }
    }
    if stats.shoot_range > 0 && m.boss().alive() {
        if require_shot(m, from, UnitId::Boss, stats.shoot_range, 0, id).is_ok() {
            out.push(Action::Shoot {
                target: UnitId::Boss,
            });
        }
        if id == MechId::Gunner
            && mech.cd_skill == 0
            && require_shot(m, from, UnitId::Boss, stats.shoot_range, 1, id).is_ok()
        {
            out.push(Action::Pierce {
                target: UnitId::Boss,
            });
        }
    }
    if id == MechId::Support && mech.cd_skill == 0 {
        for ally in m.living_ids() {
            if ally == id {
                continue;
            }
            if let Some(a) = m.mech(ally) {
                if chebyshev(from, a.pos) == 1 {
                    out.push(Action::Repair { target: ally });
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod lethal_phase_tests {
    use crate::covers::CoverPreset;
    use crate::geom::Cell;
    use crate::scripts::boss_script_tick_prepare;
    use crate::state::Phase;
    use crate::types::{Action, BossScript, MechId, Outcome, UnitId};
    use crate::{ArenaPlan, Match, MatchSeed, MechOrder};

    #[test]
    fn killing_melee_finishes_and_does_not_move_the_boss() {
        let mut seed = MatchSeed::new(9, CoverPreset::SparseMid, BossScript::StationarySmash);
        seed.board.covers.clear();
        seed.deploy.mechs = vec![
            (MechId::Assault, Cell::new(5, 3)),
            (MechId::Gunner, Cell::new(0, 9)),
            (MechId::Support, Cell::new(9, 9)),
        ];
        seed.deploy.boss = Cell::new(4, 4);
        let mut m = Match::from_seed(seed);
        m.boss_mut().hp = 2;
        let anchor = m.boss().anchor;
        boss_script_tick_prepare(&mut m).expect("prepare");
        let plan = ArenaPlan {
            revision: Some(m.revision()),
            items: vec![
                MechOrder {
                    mech_id: MechId::Assault,
                    move_to: None,
                    action: Action::Melee { target: UnitId::Boss },
                },
                MechOrder {
                    mech_id: MechId::Gunner,
                    move_to: None,
                    action: Action::Skip,
                },
                MechOrder {
                    mech_id: MechId::Support,
                    move_to: None,
                    action: Action::Skip,
                },
            ],
        };
        super::validate_and_apply_plan(&mut m, &plan).expect("lethal melee");
        assert_eq!(m.boss().hp, 0);
        assert_eq!(m.boss().anchor, anchor, "lethal damage skips the push");
        assert_eq!(m.outcome(), Some(Outcome::Victory));
        assert_eq!(m.phase(), Phase::Finished);
    }
}

