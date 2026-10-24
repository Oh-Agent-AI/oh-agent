//! Named cover presets expand only into `match_seed.board.covers`.

use mecha_tactics::{
    CoverPreset, Match, MatchSeed, BossScript, GDD_RULESET, COVERS_SPARSE_MID,
};

#[test]
fn preset_ids_match_gdd_v1_3() {
    assert_eq!(CoverPreset::SparseMid.id(), "covers_sparse_mid");
    assert_eq!(CoverPreset::DiagCorridor.id(), "covers_diag_corridor");
    assert_eq!(CoverPreset::TwinClusters.id(), "covers_twin_clusters");
    assert_eq!(CoverPreset::from_id("covers_sparse_mid"), Some(CoverPreset::SparseMid));
}

#[test]
fn seed_copies_preset_cells_into_board_covers() {
    for preset in CoverPreset::ALL {
        let seed = MatchSeed::new(1, preset, BossScript::CadenceSsw);
        assert_eq!(seed.gdd_ruleset, GDD_RULESET);
        assert_eq!(seed.board.covers, preset.cells());
        assert_eq!(seed.board.w, 10);
        assert_eq!(seed.board.h, 10);
        let m = Match::from_seed(seed);
        for c in preset.cells() {
            assert!(m.is_cover(*c), "{} missing {:?}", preset.id(), c);
        }
    }
}

#[test]
fn sparse_mid_is_two_to_three_covers() {
    assert!(COVERS_SPARSE_MID.len() >= 2 && COVERS_SPARSE_MID.len() <= 3);
    for c in &COVERS_SPARSE_MID {
        assert!(c.x >= 3 && c.x <= 6 && c.y >= 3 && c.y <= 6);
    }
}
