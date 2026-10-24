//! Script Boss ticks. Lock A/C: stationary plan only; `smash_2` is not in v1.

use crate::combat::{resolve_melee_on_mech, resolve_sweep_on_mech};
use crate::geom::{adjacent_cells, manhattan, Offset};
use crate::state::{BossIntent, IntentStatus, Match, Occupant, Phase};
use crate::types::{BossScript, BossSkill, Outcome};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecuteReport {
    pub skill_id: BossSkill,
    pub any_hit: bool,
    pub voided: bool,
}

pub fn boss_script_tick_prepare(m: &mut Match) -> Result<BossIntent, crate::plan::PlanReject> {
    if m.outcome().is_some() {
        return Err(crate::plan::PlanReject {
            code: crate::plan::RejectCode::BossIntentIllegal,
            reason: "match already finished".to_string(),
            mech_id: None,
        });
    }
    if m.phase() != Phase::EnemyPrepare {
        return Err(crate::plan::PlanReject {
            code: crate::plan::RejectCode::BossIntentIllegal,
            reason: format!("phase {:?} is not enemy_prepare", m.phase()),
            mech_id: None,
        });
    }
    if m.boss_dead() {
        m.void_intent();
        m.set_outcome(Outcome::Victory);
        return Err(crate::plan::PlanReject {
            code: crate::plan::RejectCode::BossIntentIllegal,
            reason: "boss is dead".to_string(),
            mech_id: None,
        });
    }

    let script = m.seed().boss_script;
    let intent = match script {
        BossScript::StationarySmash => plan_stationary_smash(m),
        BossScript::CadenceSsw => plan_cadence_ssw(m),
        BossScript::Mcp => plan_skip(m),
    };
    m.boss_mut().intent = Some(intent.clone());
    m.set_phase(Phase::PlayerPlan);
    m.bump_revision();
    Ok(intent)
}

pub fn boss_script_tick_execute(m: &mut Match) -> Result<ExecuteReport, crate::plan::PlanReject> {
    if m.phase() != Phase::ResolvingBoss && m.phase() != Phase::PlayerPlan {
        if m.outcome().is_some() {
            return Ok(ExecuteReport {
                skill_id: BossSkill::Skip,
                any_hit: false,
                voided: true,
            });
        }
        return Err(crate::plan::PlanReject {
            code: crate::plan::RejectCode::BossIntentIllegal,
            reason: format!("phase {:?} cannot execute intent", m.phase()),
            mech_id: None,
        });
    }
    if m.boss_dead() {
        m.void_intent();
        m.refresh_outcome();
        m.set_phase(Phase::Finished);
        return Ok(ExecuteReport {
            skill_id: BossSkill::Skip,
            any_hit: false,
            voided: true,
        });
    }
    let Some(intent) = m.boss().intent.clone() else {
        m.set_phase(Phase::EnemyPrepare);
        return Ok(ExecuteReport {
            skill_id: BossSkill::Skip,
            any_hit: false,
            voided: true,
        });
    };
    if matches!(intent.skill_id, BossSkill::Skip) || matches!(intent.status, IntentStatus::Void)
    {
        finish_execute(m, intent.skill_id, false, true);
        return Ok(ExecuteReport {
            skill_id: intent.skill_id,
            any_hit: false,
            voided: true,
        });
    }

    m.reproject_intent();
    let cells = m
        .boss()
        .intent
        .as_ref()
        .map(|i| i.projected_cells.clone())
        .unwrap_or_default();
    if cells.is_empty() {
        finish_execute(m, intent.skill_id, false, true);
        return Ok(ExecuteReport {
            skill_id: intent.skill_id,
            any_hit: false,
            voided: true,
        });
    }

    let mut any_hit = false;
    for c in cells {
        if let Occupant::Mech(id) = m.occupant(c) {
            match intent.skill_id {
                BossSkill::Smash => resolve_melee_on_mech(m, true, id),
                BossSkill::Sweep => resolve_sweep_on_mech(m, id),
                BossSkill::Skip => {}
            }
            any_hit = true;
        }
    }
    let voided = !any_hit;
    finish_execute(m, intent.skill_id, any_hit, voided);
    Ok(ExecuteReport {
        skill_id: intent.skill_id,
        any_hit,
        voided,
    })
}

fn finish_execute(m: &mut Match, skill: BossSkill, _any_hit: bool, voided: bool) {
    if skill == BossSkill::Sweep {
        m.boss_mut().cd_sweep = 1;
    } else if m.boss().cd_sweep > 0 {
        m.boss_mut().cd_sweep -= 1;
    }
    if voided {
        m.void_intent();
    }
    m.boss_mut().intent = None;
    m.refresh_outcome();
    if m.outcome().is_none() {
        m.set_phase(Phase::EnemyPrepare);
        m.bump_revision();
    }
}

fn plan_skip(m: &Match) -> BossIntent {
    BossIntent {
        skill_id: BossSkill::Skip,
        local_cells: Vec::new(),
        facing: None,
        cd_sweep: m.boss().cd_sweep,
        projected_cells: Vec::new(),
        status: IntentStatus::Planned,
    }
}

fn plan_stationary_smash(m: &Match) -> BossIntent {
    let cell = pick_smash_cell(m);
    smash_intent(m, cell)
}

fn plan_cadence_ssw(m: &mut Match) -> BossIntent {
    let step = m.boss().cadence_step % 3;
    let want_sweep = step == 2;
    let cd = m.boss().cd_sweep;
    let intent = if want_sweep && cd == 0 {
        match pick_sweep_pair(m) {
            Some((a, b)) => sweep_intent(m, a, b),
            None => smash_intent(m, pick_smash_cell(m)),
        }
    } else {
        // Cadence wanted sweep but CD is hot → smash. Smash beats stay smash.
        smash_intent(m, pick_smash_cell(m))
    };
    m.boss_mut().cadence_step = (step + 1) % 3;
    intent
}

fn smash_intent(m: &Match, cell: Option<crate::geom::Cell>) -> BossIntent {
    let Some(cell) = cell else {
        return plan_skip(m);
    };
    let off = Offset::new(cell.x - m.boss().anchor.x, cell.y - m.boss().anchor.y);
    let projected = if cell.in_bounds() {
        vec![cell]
    } else {
        Vec::new()
    };
    let status = if projected.is_empty() {
        IntentStatus::Void
    } else {
        IntentStatus::Planned
    };
    BossIntent {
        skill_id: BossSkill::Smash,
        local_cells: vec![off],
        facing: None,
        cd_sweep: m.boss().cd_sweep,
        projected_cells: projected,
        status,
    }
}

fn sweep_intent(m: &Match, a: crate::geom::Cell, b: crate::geom::Cell) -> BossIntent {
    let anchor = m.boss().anchor;
    let locals = vec![
        Offset::new(a.x - anchor.x, a.y - anchor.y),
        Offset::new(b.x - anchor.x, b.y - anchor.y),
    ];
    let mut projected = Vec::new();
    if a.in_bounds() {
        projected.push(a);
    }
    if b.in_bounds() {
        projected.push(b);
    }
    let status = if projected.len() == 2 {
        IntentStatus::Planned
    } else {
        IntentStatus::Void
    };
    BossIntent {
        skill_id: BossSkill::Sweep,
        local_cells: locals,
        facing: None,
        cd_sweep: m.boss().cd_sweep,
        projected_cells: projected,
        status,
    }
}

/// Threat: smashable mechs > buildings (cover) > empty adjacency.
pub fn threat_score(m: &Match, cell: crate::geom::Cell) -> u8 {
    match m.occupant(cell) {
        Occupant::Mech(_) => 3,
        Occupant::Cover => 2,
        _ => 1,
    }
}

/// Distance from an adjacent cell to the nearest living mech.
/// Equal threat used to fall through to the lexicographic corner. On the
/// standard deploy that corner is (3, 0), off the squad's road, so the one
/// smash cell was never a step anyone wanted and a search could melee the
/// whole match without taking boss damage. Aim the tie at the squad first.
fn approach_distance(m: &Match, cell: crate::geom::Cell) -> i8 {
    let mut best = i8::MAX;
    for id in m.living_ids() {
        if let Some(mech) = m.mech(id) {
            let d = manhattan(cell, mech.pos);
            if d < best {
                best = d;
            }
        }
    }
    best
}

pub fn pick_smash_cell(m: &Match) -> Option<crate::geom::Cell> {
    let mut best: Option<(u8, i8, crate::geom::Cell)> = None;
    for c in adjacent_cells(m.boss().anchor) {
        let t = threat_score(m, c);
        let d = approach_distance(m, c);
        let take = match best {
            None => true,
            Some((bt, bd, bc)) => t > bt || (t == bt && (d < bd || (d == bd && c < bc))),
        };
        if take {
            best = Some((t, d, c));
        }
    }
    best.map(|(_, _, c)| c)
}

pub fn pick_sweep_pair(m: &Match) -> Option<(crate::geom::Cell, crate::geom::Cell)> {
    let cells = adjacent_cells(m.boss().anchor);
    let mut best: Option<(u8, u8, i8, crate::geom::Cell, crate::geom::Cell)> = None;
    for i in 0..cells.len() {
        for j in (i + 1)..cells.len() {
            let a = cells[i];
            let b = cells[j];
            if manhattan(a, b) > 2 {
                continue;
            }
            let ta = threat_score(m, a);
            let tb = threat_score(m, b);
            let sum = ta + tb;
            let mx = ta.max(tb);
            let near = approach_distance(m, a).saturating_add(approach_distance(m, b));
            let (c0, c1) = if a < b { (a, b) } else { (b, a) };
            let take = match best {
                None => true,
                Some((bs, bm, bn, ba, bb)) => {
                    sum > bs
                        || (sum == bs && mx > bm)
                        || (sum == bs && mx == bm && near < bn)
                        || (sum == bs && mx == bm && near == bn && (c0, c1) < (ba, bb))
                }
            };
            if take {
                best = Some((sum, mx, near, c0, c1));
            }
        }
    }
    best.map(|(_, _, _, a, b)| (a, b))
}
