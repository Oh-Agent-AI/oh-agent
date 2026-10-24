//! Strategy adapters: random / rules / shallow search. Rules API only.

use crate::geom::{adjacent_to_footprint, chebyshev, Cell};
use crate::hold_plan;
use crate::plan::{legal_actions, legal_destinations, validate_and_apply_plan, ArenaPlan, MechOrder};
use crate::scripts::boss_script_tick_execute;
use crate::state::Match;
use crate::types::{Action, MechId, UnitId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StrategyKind {
    Random,
    Rules,
    Search,
}

impl StrategyKind {
    pub fn id(self) -> &'static str {
        match self {
            StrategyKind::Random => "random",
            StrategyKind::Rules => "rules",
            StrategyKind::Search => "search",
        }
    }

    pub const ALL: [StrategyKind; 3] = [
        StrategyKind::Random,
        StrategyKind::Rules,
        StrategyKind::Search,
    ];
}

pub struct PlayerStrategy {
    kind: StrategyKind,
    rng: Rng64,
}

impl PlayerStrategy {
    pub fn new(kind: StrategyKind, seed: u64) -> Self {
        PlayerStrategy {
            kind,
            rng: Rng64::new(seed),
        }
    }

    pub fn kind(&self) -> StrategyKind {
        self.kind
    }

    pub fn choose_plan(&mut self, m: &Match) -> ArenaPlan {
        match self.kind {
            StrategyKind::Random => self.random_plan(m),
            StrategyKind::Rules => rules_plan(m),
            StrategyKind::Search => self.search_plan(m),
        }
    }

    fn random_plan(&mut self, m: &Match) -> ArenaPlan {
        let mut scratch = m.clone();
        let mut items = Vec::new();
        for id in scratch.living_ids() {
            let dests = legal_destinations(&scratch, id);
            let dest = if dests.is_empty() {
                scratch.mech(id).map(|mm| mm.pos)
            } else {
                let i = self.rng.index(dests.len());
                Some(dests[i])
            };
            if let Some(d) = dest {
                if let Some(cur) = scratch.mech(id) {
                    if d != cur.pos {
                        scratch.set_mech_pos(id, d);
                    }
                }
            }
            let acts = legal_actions(&scratch, id);
            let action = if acts.is_empty() {
                Action::Skip
            } else {
                acts[self.rng.index(acts.len())]
            };
            apply_action_best_effort(&mut scratch, id, action);
            items.push(MechOrder {
                mech_id: id,
                move_to: dest,
                action,
            });
        }
        ArenaPlan {
            revision: Some(m.revision()),
            items,
        }
    }

    fn search_plan(&mut self, m: &Match) -> ArenaPlan {
        let living = m.living_ids();
        if living.is_empty() {
            return hold_plan(m);
        }
        let mut dest_opts: Vec<Vec<Cell>> = Vec::new();
        for id in &living {
            dest_opts.push(trim_dests(m, *id, 4));
        }
        let mut best_plan = rules_plan(m);
        let mut best_score = score_plan(m, &best_plan);
        let combos = cartesian(&dest_opts);
        let cap = 80.min(combos.len());
        let stride = combos.len().checked_div(cap).unwrap_or(1).max(1);
        let mut i = 0;
        while i < combos.len() {
            let dests = &combos[i];
            let plan = plan_from_dests(m, &living, dests);
            let s = score_plan(m, &plan);
            if s > best_score {
                best_score = s;
                best_plan = plan;
            }
            i += stride;
            if stride > 1 {
                let _ = self.rng.next();
            }
        }
        best_plan
    }
}

fn plan_from_dests(m: &Match, living: &[MechId], dests: &[Cell]) -> ArenaPlan {
    let mut scratch = m.clone();
    let mut items = Vec::new();
    for (idx, id) in living.iter().enumerate() {
        let dest = dests.get(idx).copied().or_else(|| scratch.mech(*id).map(|mm| mm.pos));
        if let Some(d) = dest {
            if let Some(cur) = scratch.mech(*id) {
                if d != cur.pos && crate::plan::path_distance(&scratch, cur.pos, d, *id).is_some() {
                    scratch.set_mech_pos(*id, d);
                }
            }
        }
        let action = greedy_action(&scratch, *id);
        apply_action_best_effort(&mut scratch, *id, action);
        items.push(MechOrder {
            mech_id: *id,
            move_to: dest,
            action,
        });
    }
    ArenaPlan {
        revision: Some(m.revision()),
        items,
    }
}

fn rules_plan(m: &Match) -> ArenaPlan {
    let mut scratch = m.clone();
    let mut items = Vec::new();
    for id in scratch.living_ids() {
        let dest = rules_dest(&scratch, id);
        if let Some(cur) = scratch.mech(id) {
            if dest != cur.pos {
                scratch.set_mech_pos(id, dest);
            }
        }
        let action = greedy_action(&scratch, id);
        apply_action_best_effort(&mut scratch, id, action);
        items.push(MechOrder {
            mech_id: id,
            move_to: Some(dest),
            action,
        });
    }
    ArenaPlan {
        revision: Some(m.revision()),
        items,
    }
}

fn rules_dest(m: &Match, id: MechId) -> Cell {
    let Some(mech) = m.mech(id) else {
        return Cell::new(0, 0);
    };
    let dests = legal_destinations(m, id);
    if dests.is_empty() {
        return mech.pos;
    }
    let boss = m.boss().anchor;
    let mut best = mech.pos;
    let mut best_key = (i16::MIN, i16::MIN, i16::MAX, i16::MAX);
    for d in dests {
        let on_red: i16 = if m.is_telegraph(d) { 0 } else { 1 };
        let dist = chebyshev(d, boss) as i16;
        let approach = match id {
            MechId::Assault => -dist,
            MechId::Gunner => {
                let range = id.stats().shoot_range as i16;
                if dist <= range && (d.x == boss.x || d.x == boss.x + 1 || d.y == boss.y || d.y == boss.y + 1)
                {
                    4 - (range - dist).abs()
                } else {
                    -dist
                }
            }
            MechId::Support => {
                let hurt = m.living_ids().iter().any(|a| {
                    *a != id
                        && m.mech(*a)
                            .map(|mm| mm.hp + 3 < mm.max_hp() && chebyshev(d, mm.pos) <= 1)
                            .unwrap_or(false)
                });
                if hurt {
                    6
                } else {
                    -dist
                }
            }
        };
        let key = (on_red, approach, -(d.y as i16), -(d.x as i16));
        if key > best_key {
            best_key = key;
            best = d;
        }
    }
    best
}

fn greedy_action(m: &Match, id: MechId) -> Action {
    let acts = legal_actions(m, id);
    let mut best = Action::Skip;
    let mut best_s = -1i32;
    for a in acts {
        let s = match a {
            Action::Charge => 50,
            Action::Melee { target: UnitId::Boss } => 40,
            Action::Pierce { target: UnitId::Boss } => 35,
            Action::Shoot { target: UnitId::Boss } => 30,
            Action::Repair { .. } => 25,
            Action::Skip => 0,
            _ => 5,
        };
        if s > best_s {
            best_s = s;
            best = a;
        }
    }
    best
}

fn score_plan(m: &Match, plan: &ArenaPlan) -> i32 {
    let mut c = m.clone();
    if validate_and_apply_plan(&mut c, plan).is_err() {
        return i32::MIN / 4;
    }
    let _ = boss_script_tick_execute(&mut c);
    let mut s: i32 = 0;
    if c.boss_dead() {
        s += 10_000;
    }
    s += (crate::BOSS_HP as i32 - c.boss().hp as i32) * 12;
    for id in MechId::ALL {
        match c.mech_even_dead(id) {
            Some(mm) if mm.alive() => {
                s += mm.hp as i32 * 3;
                if c.adjacent_to_boss(mm.pos) && id == MechId::Assault {
                    s += 8;
                }
                if c.is_telegraph(mm.pos) {
                    s -= 20;
                }
            }
            Some(_) => s -= 400,
            None => s -= 400,
        }
    }
    s
}

fn trim_dests(m: &Match, id: MechId, k: usize) -> Vec<Cell> {
    let mut dests = legal_destinations(m, id);
    if dests.is_empty() {
        if let Some(mm) = m.mech(id) {
            return vec![mm.pos];
        }
        return Vec::new();
    }
    let boss = m.boss().anchor;
    dests.sort_by_key(|d| {
        let red = if m.is_telegraph(*d) { 1 } else { 0 };
        let dist = chebyshev(*d, boss);
        (red, dist, d.y, d.x)
    });
    dests.truncate(k);
    if let Some(mm) = m.mech(id) {
        if !dests.contains(&mm.pos) {
            dests.push(mm.pos);
        }
    }
    dests
}

fn cartesian(opts: &[Vec<Cell>]) -> Vec<Vec<Cell>> {
    let mut acc = vec![Vec::new()];
    for group in opts {
        let mut next = Vec::new();
        for prefix in &acc {
            for c in group {
                let mut row = prefix.clone();
                row.push(*c);
                next.push(row);
            }
        }
        acc = next;
        if acc.len() > 160 {
            acc.truncate(160);
        }
    }
    acc
}

fn apply_action_best_effort(m: &mut Match, id: MechId, action: Action) {
    match action {
        Action::Charge => {
            if m.mech(id).is_some() && m.boss().alive() {
                if let Some(mm) = m.mech(id) {
                    if adjacent_to_footprint(m.boss().anchor, mm.pos) {
                        crate::combat::resolve_melee_on_boss(m, id, 2);
                    }
                }
            }
        }
        Action::Melee { target: UnitId::Boss } => {
            crate::combat::resolve_melee_on_boss(m, id, 0);
        }
        Action::Shoot { target: UnitId::Boss } | Action::Pierce { target: UnitId::Boss } => {
            crate::combat::resolve_ranged_on_boss(m, id);
        }
        Action::Repair { target } => crate::combat::apply_repair(m, target),
        _ => {}
    }
}

struct Rng64(u64);

impl Rng64 {
    fn new(seed: u64) -> Self {
        Rng64(if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed })
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn index(&mut self, n: usize) -> usize {
        (self.next() as usize).checked_rem(n).unwrap_or(0)
    }
}
