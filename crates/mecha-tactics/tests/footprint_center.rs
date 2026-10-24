//! Acceptance: Boss `footprint_center` = `anchor + (1.0, 1.0)`, never +0.5.

use mecha_tactics::{
    attacker_center, boss_script_tick_prepare, footprint_center, hold_plan, knockback_dir_from_attacker,
    primary_axis, validate_and_apply_plan, Action, ArenaPlan, BossScript, Cell, CoverPreset, Dir,
    Match, MatchSeed, MechId, MechOrder, UnitId,
};

fn wrong_nw_cell_center(anchor: Cell) -> (f64, f64) {
    (anchor.x as f64 + 0.5, anchor.y as f64 + 0.5)
}

#[test]
fn two_by_two_center_is_anchor_plus_one_not_plus_half() {
    let anchor = Cell::new(4, 4);
    assert_eq!(footprint_center(anchor), (5.0, 5.0));
    assert_ne!(footprint_center(anchor), wrong_nw_cell_center(anchor));
    assert_eq!(wrong_nw_cell_center(anchor), (4.5, 4.5));
}

#[test]
fn one_by_one_attacker_center_stays_plus_half() {
    assert_eq!(attacker_center(Cell::new(5, 3)), (5.5, 3.5));
    assert_eq!(attacker_center(Cell::new(0, 0)), (0.5, 0.5));
}

#[test]
fn discriminating_cell_prefers_true_center_over_nw_cell() {
    // Boss 2×2 at (4,4). Attacker on (5,3) is adjacent.
    // True center (5.0, 5.0): delta = (-0.5, 1.5) → vertical south.
    // Wrong NW-cell +0.5 (4.5, 4.5): delta = (-1.0, 1.0) → lock D horizontal west.
    let anchor = Cell::new(4, 4);
    let attacker = Cell::new(5, 3);
    let (fx, fy) = footprint_center(anchor);
    let (ax, ay) = attacker_center(attacker);
    assert_eq!(primary_axis(fx - ax, fy - ay), Dir::S);
    assert_eq!(knockback_dir_from_attacker(attacker, anchor), Dir::S);

    let (wx, wy) = wrong_nw_cell_center(anchor);
    assert_eq!(primary_axis(wx - ax, wy - ay), Dir::W);
}

#[test]
fn lock_d_tie_breaks_horizontal() {
    let anchor = Cell::new(4, 4);
    let attacker = Cell::new(3, 3);
    // True center delta (1.5, 1.5) → horizontal east.
    assert_eq!(knockback_dir_from_attacker(attacker, anchor), Dir::E);
}

#[test]
fn melee_knockback_uses_footprint_center_axis() {
    let mut seed = MatchSeed::new(7, CoverPreset::SparseMid, BossScript::StationarySmash);
    seed.board.covers.clear();
    seed.deploy.mechs = vec![
        (MechId::Assault, Cell::new(5, 3)),
        (MechId::Gunner, Cell::new(0, 9)),
        (MechId::Support, Cell::new(9, 9)),
    ];
    seed.deploy.boss = Cell::new(4, 4);
    let mut m = Match::from_seed(seed);
    boss_script_tick_prepare(&mut m).expect("prepare");
    let plan = ArenaPlan {
        revision: Some(m.revision()),
        items: vec![
            MechOrder {
                mech_id: MechId::Assault,
                move_to: None,
                action: Action::Melee {
                    target: UnitId::Boss,
                },
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
    validate_and_apply_plan(&mut m, &plan).expect("melee pack");
    assert_eq!(
        m.boss().anchor,
        Cell::new(4, 5),
        "true center pushes south; +0.5 would have pushed west"
    );
}

#[test]
fn hold_plan_compiles_against_api() {
    let seed = MatchSeed::new(1, CoverPreset::SparseMid, BossScript::StationarySmash);
    let mut m = Match::from_seed(seed);
    boss_script_tick_prepare(&mut m).unwrap();
    let _ = hold_plan(&m);
}
