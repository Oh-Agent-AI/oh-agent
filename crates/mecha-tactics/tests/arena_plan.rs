//! Acceptance: `arena_plan` whole-pack validate; any illegal → full rollback.

use mecha_tactics::{
    boss_script_tick_prepare, hold_plan, validate_and_apply_plan, Action, ArenaPlan, BossScript,
    Cell, CoverPreset, Match, MatchSeed, MechId, MechOrder, Phase, RejectCode,
};

fn prepared() -> Match {
    let seed = MatchSeed::new(21, CoverPreset::SparseMid, BossScript::StationarySmash);
    let mut m = Match::from_seed(seed);
    boss_script_tick_prepare(&mut m).expect("prepare");
    m
}

fn pos(m: &Match, id: MechId) -> Cell {
    m.mech(id).expect("alive").pos
}

#[test]
fn legal_pack_applies() {
    let mut m = prepared();
    let before = m.revision();
    let plan = ArenaPlan {
        revision: Some(before),
        items: vec![
            MechOrder {
                mech_id: MechId::Assault,
                move_to: Some(Cell::new(2, 8)),
                action: Action::Skip,
            },
            MechOrder {
                mech_id: MechId::Gunner,
                move_to: Some(Cell::new(5, 8)),
                action: Action::Skip,
            },
            MechOrder {
                mech_id: MechId::Support,
                move_to: None,
                action: Action::Skip,
            },
        ],
    };
    validate_and_apply_plan(&mut m, &plan).expect("legal pack");
    assert_eq!(pos(&m, MechId::Assault), Cell::new(2, 8));
    assert_eq!(pos(&m, MechId::Gunner), Cell::new(5, 8));
    assert_eq!(pos(&m, MechId::Support), Cell::new(8, 9));
    assert!(m.revision() > before);
    assert_eq!(m.phase(), Phase::ResolvingBoss);
}

#[test]
fn illegal_second_order_rolls_back_the_whole_pack() {
    let mut m = prepared();
    let origin_a = pos(&m, MechId::Assault);
    let origin_g = pos(&m, MechId::Gunner);
    let origin_s = pos(&m, MechId::Support);
    let rev = m.revision();
    let plan = ArenaPlan {
        revision: Some(rev),
        items: vec![
            MechOrder {
                mech_id: MechId::Assault,
                move_to: Some(Cell::new(2, 8)),
                action: Action::Skip,
            },
            MechOrder {
                mech_id: MechId::Gunner,
                move_to: Some(Cell::new(5, 0)),
                action: Action::Skip,
            },
            MechOrder {
                mech_id: MechId::Support,
                move_to: None,
                action: Action::Skip,
            },
        ],
    };
    let err = validate_and_apply_plan(&mut m, &plan).expect_err("must reject");
    assert_eq!(err.code, RejectCode::PlanPackRejected);
    assert_eq!(pos(&m, MechId::Assault), origin_a, "no partial apply");
    assert_eq!(pos(&m, MechId::Gunner), origin_g);
    assert_eq!(pos(&m, MechId::Support), origin_s);
    assert_eq!(m.revision(), rev, "rejected pack keeps the same position");
    assert_eq!(m.phase(), Phase::PlayerPlan);
}

#[test]
fn same_position_may_resubmit_after_reject() {
    let mut m = prepared();
    let bad = ArenaPlan {
        revision: Some(m.revision()),
        items: vec![
            MechOrder {
                mech_id: MechId::Assault,
                move_to: Some(Cell::new(2, 0)),
                action: Action::Skip,
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
    assert!(validate_and_apply_plan(&mut m, &bad).is_err());
    let good = hold_plan(&m);
    validate_and_apply_plan(&mut m, &good).expect("resubmit from same revision");
}

#[test]
fn duplicate_destination_rejects_without_moving_the_first_mech() {
    let mut m = prepared();
    let origin_a = pos(&m, MechId::Assault);
    let origin_g = pos(&m, MechId::Gunner);
    let plan = ArenaPlan {
        revision: Some(m.revision()),
        items: vec![
            MechOrder {
                mech_id: MechId::Assault,
                move_to: Some(Cell::new(4, 9)),
                action: Action::Skip,
            },
            MechOrder {
                mech_id: MechId::Gunner,
                move_to: Some(Cell::new(4, 9)),
                action: Action::Skip,
            },
            MechOrder {
                mech_id: MechId::Support,
                move_to: None,
                action: Action::Skip,
            },
        ],
    };
    assert!(validate_and_apply_plan(&mut m, &plan).is_err());
    assert_eq!(pos(&m, MechId::Assault), origin_a);
    assert_eq!(pos(&m, MechId::Gunner), origin_g);
}

#[test]
fn missing_mech_is_need_all() {
    let mut m = prepared();
    let plan = ArenaPlan {
        revision: Some(m.revision()),
        items: vec![MechOrder {
            mech_id: MechId::Assault,
            move_to: None,
            action: Action::Skip,
        }],
    };
    let err = validate_and_apply_plan(&mut m, &plan).expect_err("need all");
    assert_eq!(err.code, RejectCode::NeedAllOrConfirm);
}
