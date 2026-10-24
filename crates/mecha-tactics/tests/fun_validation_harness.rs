//! Harness smoke: three strategies × three cover presets vs `cadence_ssw`.

use mecha_tactics::{run_fun_validation, CoverPreset, FunValidationConfig, StrategyKind, GDD_RULESET};

#[test]
fn batch_cycles_presets_and_strategies() {
    let report = run_fun_validation(FunValidationConfig {
        matches_per_combo: 1,
        base_seed: 42,
    });
    assert_eq!(report.gdd_ruleset, GDD_RULESET);
    assert_eq!(report.boss_script, "cadence_ssw");
    assert_eq!(
        report.combos.len(),
        CoverPreset::ALL.len() * StrategyKind::ALL.len()
    );
    for kind in StrategyKind::ALL {
        for preset in CoverPreset::ALL {
            assert!(
                report
                    .combos
                    .iter()
                    .any(|c| c.strategy == kind.id() && c.cover_preset == preset.id() && c.matches == 1),
                "missing combo {} / {}",
                kind.id(),
                preset.id()
            );
        }
    }
    assert!(report.disclaimer.contains("Scaffolding"));
}
