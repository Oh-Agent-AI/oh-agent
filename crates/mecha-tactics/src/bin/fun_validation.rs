//! Thin CLI: cycle cover presets × random/rules/search vs `cadence_ssw`.

use mecha_tactics::{run_fun_validation, FunValidationConfig};

fn main() {
    let n = std::env::args()
        .nth(1)
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(8);
    let report = run_fun_validation(FunValidationConfig {
        matches_per_combo: n,
        base_seed: 0xC0F1_0001,
    });
    print!("{}", report.format_text());
}
