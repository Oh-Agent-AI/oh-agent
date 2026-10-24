//! Deterministic match loop and Combat Fun Validation batch harness.

use crate::covers::CoverPreset;
use crate::hold_plan;
use crate::plan::validate_and_apply_plan;
use crate::scripts::{boss_script_tick_execute, boss_script_tick_prepare};
use crate::state::{Match, MatchSeed, Phase};
use crate::strategy::{PlayerStrategy, StrategyKind};
use crate::types::{BossScript, Outcome};
use crate::MAX_TURNS;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchResult {
    pub outcome: Outcome,
    pub turns: u8,
    pub boss_hp: u16,
    pub living_mechs: u8,
    pub seed_u64: u64,
    pub cover_preset: &'static str,
    pub strategy: &'static str,
    pub decisive_swings: u32,
}

pub fn run_match(mut m: Match, player: &mut PlayerStrategy) -> MatchResult {
    let seed_u64 = m.seed().seed_u64;
    let cover = m.seed().cover_preset.id();
    let strategy = player.kind().id();
    let mut decisive = 0u32;
    let mut prev_boss = m.boss().hp;
    let mut prev_living = m.living_ids().len();

    for turn in 1..=MAX_TURNS {
        m.set_turn(turn);
        if m.outcome().is_some() {
            break;
        }
        if m.phase() == Phase::EnemyPrepare && boss_script_tick_prepare(&mut m).is_err() {
            break;
        }
        if m.outcome().is_some() {
            break;
        }
        let mut attempts = 0u8;
        loop {
            let plan = player.choose_plan(&m);
            match validate_and_apply_plan(&mut m, &plan) {
                Ok(_) => break,
                Err(_) => {
                    attempts = attempts.saturating_add(1);
                    if attempts >= 6 {
                        let hold = hold_plan(&m);
                        let _ = validate_and_apply_plan(&mut m, &hold);
                        break;
                    }
                }
            }
        }
        let boss_now = m.boss().hp;
        if prev_boss.saturating_sub(boss_now) >= 6 {
            decisive += 1;
        }
        prev_boss = boss_now;
        if m.boss_dead() {
            m.void_intent();
            m.refresh_outcome();
            break;
        }
        let _ = boss_script_tick_execute(&mut m);
        let living_now = m.living_ids().len();
        if living_now < prev_living {
            decisive += 1;
        }
        prev_living = living_now;
        if m.outcome().is_some() {
            break;
        }
    }
    if m.outcome().is_none() {
        if m.boss_dead() {
            m.set_outcome(Outcome::Victory);
        } else if m.all_mechs_dead() {
            m.set_outcome(Outcome::DefeatWipe);
        } else {
            m.set_outcome(Outcome::DefeatTimeout);
        }
    }
    MatchResult {
        outcome: m.outcome().unwrap_or(Outcome::DefeatTimeout),
        turns: m.turn(),
        boss_hp: m.boss().hp,
        living_mechs: m.living_ids().len() as u8,
        seed_u64,
        cover_preset: cover,
        strategy,
        decisive_swings: decisive,
    }
}

#[derive(Clone, Debug)]
pub struct FunValidationConfig {
    pub matches_per_combo: u32,
    pub base_seed: u64,
}

impl Default for FunValidationConfig {
    fn default() -> Self {
        FunValidationConfig {
            matches_per_combo: 8,
            base_seed: 0xC0F1_0001,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComboStats {
    pub strategy: &'static str,
    pub cover_preset: &'static str,
    pub matches: u32,
    pub wins: u32,
    pub wipe_losses: u32,
    pub timeout_losses: u32,
    pub decisive_swing_matches: u32,
    pub mean_boss_hp_on_loss_x10: i32,
    pub mean_turns_x10: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FunValidationReport {
    pub gdd_ruleset: &'static str,
    pub boss_script: &'static str,
    pub combos: Vec<ComboStats>,
    pub disclaimer: &'static str,
}

pub fn run_fun_validation(cfg: FunValidationConfig) -> FunValidationReport {
    let mut combos = Vec::new();
    for preset in CoverPreset::ALL {
        for kind in StrategyKind::ALL {
            let mut wins = 0u32;
            let mut wipe = 0u32;
            let mut timeout = 0u32;
            let mut swing_matches = 0u32;
            let mut loss_hp_sum = 0u32;
            let mut loss_n = 0u32;
            let mut turns_sum = 0u32;
            let n = cfg.matches_per_combo;
            for i in 0..n {
                let seed_u64 = cfg.base_seed
                    ^ ((i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
                    ^ ((preset as u64) << 8)
                    ^ (kind as u64);
                let seed = MatchSeed::new(seed_u64, preset, BossScript::CadenceSsw);
                let m = Match::from_seed(seed);
                let mut player = PlayerStrategy::new(kind, seed_u64);
                let r = run_match(m, &mut player);
                turns_sum += r.turns as u32;
                if r.decisive_swings > 0 {
                    swing_matches += 1;
                }
                match r.outcome {
                    Outcome::Victory => wins += 1,
                    Outcome::DefeatWipe => {
                        wipe += 1;
                        loss_hp_sum += r.boss_hp as u32;
                        loss_n += 1;
                    }
                    Outcome::DefeatTimeout => {
                        timeout += 1;
                        loss_hp_sum += r.boss_hp as u32;
                        loss_n += 1;
                    }
                }
            }
            let mean_loss = (loss_hp_sum * 10).checked_div(loss_n).unwrap_or(0);
            combos.push(ComboStats {
                strategy: kind.id(),
                cover_preset: preset.id(),
                matches: n,
                wins,
                wipe_losses: wipe,
                timeout_losses: timeout,
                decisive_swing_matches: swing_matches,
                mean_boss_hp_on_loss_x10: mean_loss as i32,
                mean_turns_x10: (turns_sum * 10).checked_div(n).unwrap_or(0) as i32,
            });
        }
    }
    FunValidationReport {
        gdd_ruleset: crate::GDD_RULESET,
        boss_script: BossScript::CadenceSsw.id(),
        combos,
        disclaimer: "Scaffolding only: win rate here measures that the harness and three adapters run, not that v1 numbers are balanced.",
    }
}

impl FunValidationReport {
    pub fn format_text(&self) -> String {
        let mut s = String::new();
        s.push_str(&format!(
            "gdd_ruleset={} boss_script={}\n",
            self.gdd_ruleset, self.boss_script
        ));
        s.push_str(self.disclaimer);
        s.push('\n');
        for c in &self.combos {
            let wr = (c.wins * 100).checked_div(c.matches).unwrap_or(0);
            s.push_str(&format!(
                "  {} / {}: n={} wins={} ({}%) wipe={} timeout={} swings={} mean_loss_boss_hp={}.{} mean_turns={}.{}\n",
                c.strategy,
                c.cover_preset,
                c.matches,
                c.wins,
                wr,
                c.wipe_losses,
                c.timeout_losses,
                c.decisive_swing_matches,
                c.mean_boss_hp_on_loss_x10 / 10,
                c.mean_boss_hp_on_loss_x10 % 10,
                c.mean_turns_x10 / 10,
                c.mean_turns_x10 % 10
            ));
        }
        s
    }
}
