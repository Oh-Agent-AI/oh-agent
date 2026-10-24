//! Acceptance: `cadence_ssw` smash→smash→sweep, CD fallback, threat pair pick.

use mecha_tactics::{
    boss_script_tick_execute, boss_script_tick_prepare, hold_plan, validate_and_apply_plan,
    BossScript, BossSkill, Cell, CoverPreset, Match, MatchSeed, MechId,
};

fn hold_and_execute(m: &mut Match) {
    let plan = hold_plan(m);
    validate_and_apply_plan(m, &plan).expect("hold");
    boss_script_tick_execute(m).expect("execute");
}

#[test]
fn cadence_is_smash_smash_sweep() {
    let seed = MatchSeed::new(11, CoverPreset::SparseMid, BossScript::CadenceSsw);
    let mut m = Match::from_seed(seed);
    let mut skills = Vec::new();
    for _ in 0..3 {
        let intent = boss_script_tick_prepare(&mut m).expect("prepare");
        skills.push(intent.skill_id);
        hold_and_execute(&mut m);
    }
    assert_eq!(
        skills,
        vec![BossSkill::Smash, BossSkill::Smash, BossSkill::Sweep]
    );
}

#[test]
fn sweep_falls_back_to_smash_when_cd_sweep_nonzero() {
    let seed = MatchSeed::new(12, CoverPreset::SparseMid, BossScript::CadenceSsw);
    let mut m = Match::from_seed(seed);
    m.set_script_counters(2, 1);
    let intent = boss_script_tick_prepare(&mut m).expect("prepare");
    assert_eq!(intent.skill_id, BossSkill::Smash);
    assert_eq!(intent.cd_sweep, 1);
}

#[test]
fn sweep_picks_highest_threat_adjacent_pair() {
    let mut seed = MatchSeed::new(13, CoverPreset::SparseMid, BossScript::CadenceSsw);
    seed.board.covers = vec![Cell::new(6, 0)];
    seed.deploy.mechs = vec![
        (MechId::Assault, Cell::new(6, 1)),
        (MechId::Gunner, Cell::new(0, 9)),
        (MechId::Support, Cell::new(9, 9)),
    ];
    seed.deploy.boss = Cell::new(4, 0);
    let mut m = Match::from_seed(seed);
    m.set_script_counters(2, 0);
    let intent = boss_script_tick_prepare(&mut m).expect("prepare");
    assert_eq!(intent.skill_id, BossSkill::Sweep);
    let mut cells = intent.projected_cells.clone();
    cells.sort();
    assert_eq!(cells, vec![Cell::new(6, 0), Cell::new(6, 1)]);
}

#[test]
fn stationary_smash_never_sweeps() {
    let seed = MatchSeed::new(14, CoverPreset::SparseMid, BossScript::StationarySmash);
    let mut m = Match::from_seed(seed);
    for _ in 0..4 {
        let intent = boss_script_tick_prepare(&mut m).expect("prepare");
        assert_eq!(intent.skill_id, BossSkill::Smash);
        assert_eq!(intent.projected_cells.len(), 1);
        hold_and_execute(&mut m);
    }
}

#[test]
fn smash_aims_at_the_squad_approach_not_the_near_corner() {
    // Standard deploy. Lexicographic adjacency would mark (3, 0). Gunner at
    // (5, 9) makes (5, 2) the closest door, seven steps due south of him.
    let seed = MatchSeed::new(21, CoverPreset::SparseMid, BossScript::CadenceSsw);
    let mut m = Match::from_seed(seed);
    let intent = boss_script_tick_prepare(&mut m).expect("prepare");
    assert_eq!(intent.skill_id, BossSkill::Smash);
    assert_eq!(intent.projected_cells, vec![Cell::new(5, 2)]);
    assert_ne!(intent.projected_cells, vec![Cell::new(3, 0)]);
}

#[test]
fn smash_2_is_not_a_v1_skill_id() {
    let seed = MatchSeed::new(15, CoverPreset::TwinClusters, BossScript::CadenceSsw);
    let mut m = Match::from_seed(seed);
    for _ in 0..6 {
        let intent = boss_script_tick_prepare(&mut m).expect("prepare");
        assert!(
            matches!(
                intent.skill_id,
                BossSkill::Smash | BossSkill::Sweep | BossSkill::Skip
            ),
            "smash_2 must not appear"
        );
        hold_and_execute(&mut m);
        if m.outcome().is_some() {
            break;
        }
    }
}
