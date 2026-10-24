//! Damage, knockback, rigid Boss translation. Locks D/E/F, §3.2.

use crate::geom::{
    knockback_dir_from_attacker, knockback_dir_from_boss, occupies_footprint, Cell, Dir,
};
use crate::state::{Match, Occupant};
use crate::types::MechId;
use crate::{COLLISION_DAMAGE, REPAIR_AMOUNT};

pub(crate) fn strike_damage(atk: i16, def: i16) -> u16 {
    let d = atk - def;
    if d > 1 {
        d as u16
    } else {
        1
    }
}

pub(crate) fn apply_damage_to_mech(m: &mut Match, id: MechId, amount: u16) {
    let died = {
        let Some(mech) = m.mech_mut(id) else {
            return;
        };
        if mech.hp <= amount {
            mech.hp = 0;
            true
        } else {
            mech.hp -= amount;
            false
        }
    };
    if died {
        m.refresh_outcome();
    }
}

pub(crate) fn apply_damage_to_boss(m: &mut Match, amount: u16) {
    if !m.boss().alive() {
        return;
    }
    let hp = m.boss().hp;
    if hp <= amount {
        m.boss_mut().hp = 0;
        m.void_intent();
        m.refresh_outcome();
    } else {
        m.boss_mut().hp = hp - amount;
    }
}

pub(crate) fn repair_mech(m: &mut Match, id: MechId, amount: u16) {
    if let Some(mech) = m.mech_mut(id) {
        let cap = mech.max_hp();
        let next = mech.hp.saturating_add(amount);
        mech.hp = if next > cap { cap } else { next };
    }
}

/// Lock F: primary damage first; lethal skips push.
pub(crate) fn resolve_melee_on_boss(m: &mut Match, attacker: MechId, bonus_atk: i16) {
    let Some(mech) = m.mech(attacker) else {
        return;
    };
    let atk = mech.id.stats().atk + bonus_atk;
    let dmg = strike_damage(atk, crate::BOSS_DEF);
    let from = mech.pos;
    apply_damage_to_boss(m, dmg);
    if m.boss().alive() {
        let dir = knockback_dir_from_attacker(from, m.boss().anchor);
        try_translate_boss(m, dir);
    }
}

pub(crate) fn resolve_ranged_on_boss(m: &mut Match, attacker: MechId) {
    let Some(mech) = m.mech(attacker) else {
        return;
    };
    let dmg = strike_damage(mech.id.stats().atk, crate::BOSS_DEF);
    apply_damage_to_boss(m, dmg);
}

pub(crate) fn resolve_melee_on_mech(m: &mut Match, attacker_is_boss: bool, target: MechId) {
    if !attacker_is_boss {
        return;
    }
    let Some(mech) = m.mech(target) else {
        return;
    };
    let dmg = strike_damage(crate::BOSS_ATK, mech.id.stats().def);
    let pos = mech.pos;
    apply_damage_to_mech(m, target, dmg);
    if m.mech(target).is_some() {
        let dir = knockback_dir_from_boss(m.boss().anchor, pos);
        try_push_mech(m, target, dir);
    }
}

pub(crate) fn resolve_sweep_on_mech(m: &mut Match, target: MechId) {
    let Some(mech) = m.mech(target) else {
        return;
    };
    let dmg = strike_damage(crate::BOSS_ATK, mech.id.stats().def);
    apply_damage_to_mech(m, target, dmg);
}

pub(crate) fn try_translate_boss(m: &mut Match, dir: Dir) -> bool {
    if !m.boss().alive() {
        return false;
    }
    let anchor = m.boss().anchor;
    let dests: [Cell; 4] = [
        Cell::new(anchor.x + dir.dx, anchor.y + dir.dy),
        Cell::new(anchor.x + 1 + dir.dx, anchor.y + dir.dy),
        Cell::new(anchor.x + dir.dx, anchor.y + 1 + dir.dy),
        Cell::new(anchor.x + 1 + dir.dx, anchor.y + 1 + dir.dy),
    ];
    let mut hit_mech: Option<MechId> = None;
    for nc in dests {
        if !nc.in_bounds() {
            apply_damage_to_boss(m, COLLISION_DAMAGE);
            return false;
        }
        if m.is_cover(nc) {
            apply_damage_to_boss(m, COLLISION_DAMAGE);
            return false;
        }
        if occupies_footprint(anchor, nc) {
            continue;
        }
        match m.occupant(nc) {
            Occupant::Mech(id) => {
                hit_mech = Some(id);
                break;
            }
            Occupant::Boss => {}
            Occupant::Cover => {
                apply_damage_to_boss(m, COLLISION_DAMAGE);
                return false;
            }
            Occupant::Empty => {}
        }
    }
    if let Some(id) = hit_mech {
        apply_damage_to_boss(m, COLLISION_DAMAGE);
        apply_damage_to_mech(m, id, COLLISION_DAMAGE);
        return false;
    }
    m.boss_mut().anchor = Cell::new(anchor.x + dir.dx, anchor.y + dir.dy);
    m.reproject_intent();
    true
}

pub(crate) fn try_push_mech(m: &mut Match, id: MechId, dir: Dir) -> bool {
    let Some(mech) = m.mech(id) else {
        return false;
    };
    let dest = mech.pos.translate(dir);
    if !dest.in_bounds() {
        apply_damage_to_mech(m, id, COLLISION_DAMAGE);
        return false;
    }
    if m.is_cover(dest) {
        apply_damage_to_mech(m, id, COLLISION_DAMAGE);
        return false;
    }
    if m.boss().alive() && occupies_footprint(m.boss().anchor, dest) {
        apply_damage_to_mech(m, id, COLLISION_DAMAGE);
        apply_damage_to_boss(m, COLLISION_DAMAGE);
        return false;
    }
    match m.occupant(dest) {
        Occupant::Mech(other) if other != id => {
            apply_damage_to_mech(m, id, COLLISION_DAMAGE);
            apply_damage_to_mech(m, other, COLLISION_DAMAGE);
            false
        }
        Occupant::Boss => {
            apply_damage_to_mech(m, id, COLLISION_DAMAGE);
            apply_damage_to_boss(m, COLLISION_DAMAGE);
            false
        }
        Occupant::Cover => {
            apply_damage_to_mech(m, id, COLLISION_DAMAGE);
            false
        }
        Occupant::Empty | Occupant::Mech(_) => {
            m.set_mech_pos(id, dest);
            true
        }
    }
}

pub(crate) fn apply_repair(m: &mut Match, target: MechId) {
    repair_mech(m, target, REPAIR_AMOUNT);
}
