//! Seed ~4100 sessions into AGENT_VITALS_HOME for City v3 paging click-throughs.
//! Usage: cargo run -p agent-vitals-query --example seed_city_home -- /path/to/home [count]
use std::path::PathBuf;
use agent_vitals_data::authority::{AuthorityDb, default_authority_path};

fn main() {
    let home = PathBuf::from(std::env::args().nth(1).or_else(|| std::env::var("CITY_V3_SEED_HOME").ok())
        .expect("usage: seed_city_home <AGENT_VITALS_HOME> [count]"));
    let count: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(4101);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    std::fs::create_dir_all(&home).unwrap();
    let db = AuthorityDb::open(&default_authority_path(&home), now).unwrap();
    db.begin_run("fixture", "cli", now).unwrap();
    db.conn().execute_batch("BEGIN").unwrap();
    for index in 0..count {
        let key = format!("private-{index:05}");
        db.conn().execute(
            "INSERT INTO sessions(session_key,harness,native_session_id,machine_namespace,last_observed_at_ms)
             VALUES(?1,'codex',?1,'private-machine',?2)",
            rusqlite::params![key, now],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,session_key,
                source_event_id,observation_kind,event_ts_ms,model_id,uncached_input_tokens,cache_read_tokens,cache_write_tokens,
                output_tokens,ingested_run_id,created_at_ms,updated_at_ms)
             VALUES(?1,'codex','private-machine',?2,?2,?1,'delta',?3,?4,10,20,30,40,'fixture',?5,?5)",
            rusqlite::params![
                format!("fact-{index}"),
                key,
                now - 1000 - index as i64,
                if index + 1 == count { "outside-cap-model" } else { "visible-model" },
                now
            ],
        ).unwrap();
    }
    db.conn().execute_batch("COMMIT").unwrap();
    db.finish_run("fixture", "succeeded", None, None, now).unwrap();
    println!("seeded {count} sessions into {}", home.display());
}
