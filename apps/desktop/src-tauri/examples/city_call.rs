//! City face 外部运行器（真机/本地验收走查用，本地进程限定）：
//! `city_call <data_home> <city_instance> <method> [payload_json]`
//! 经与 City UI 相同的 dispatch_city_runtime 管线驱动玩家面方法。
use serde_json::{json, Value};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: city_call <data_home> <city_instance> <method> [payload_json]");
        std::process::exit(2);
    }
    let home = std::path::PathBuf::from(&args[1]);
    let instance = args[2].clone();
    let method = args[3].clone();
    let payload: Value = args.iter().skip(4)
        .find(|a| !a.starts_with("--"))
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_else(|| json!({}));
    match agent_vitals_menubar_lib::dispatch_city_runtime(&home, &instance, &method, &payload) {
        Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default()),
        Err(code) => {
            eprintln!("error {code}");
            std::process::exit(1);
        }
    }
}
