// Remote match wire contracts. Keep these in sync with the versioned City
// contracts in game/mecha/{contracts,board.ts,rules/pvp.ts}. Deserialization
// is deliberately strict at every object boundary: accepting an opaque Value
// here would allow local data to escape through a nested extension field.
#![allow(dead_code)]
use serde::Deserialize;
use serde_json::Value;

const PVE: &str = "mecha-v1.4";
const PVP: &str = "mecha-pvp:v1";
const NET: &str = "mecha-net:v1";

fn numeric_id(value: &str, prefix: &str, min_digits: usize) -> bool {
    value.strip_prefix(prefix).is_some_and(|digits| digits.len() >= min_digits && digits.len() <= 12 && digits.bytes().all(|b| b.is_ascii_digit()))
}
fn mech(value: &str) -> bool { matches!(value, "Assault" | "Gunner" | "Support") }
fn building(value: &str) -> bool { numeric_id(value, "building-", 4) || numeric_id(value, "other-building-", 4) }
fn raider(value: &str) -> bool { numeric_id(value, "raider-", 1) }
fn unit(value: &str) -> bool {
    value == "boss" || mech(value) || raider(value)
        || value.strip_prefix("A:").or_else(|| value.strip_prefix("B:")).is_some_and(mech)
}
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 80 && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'))
}
fn terrain(rows: &[Vec<String>]) -> bool {
    rows.iter().flatten().all(|value| matches!(value.as_str(), "land" | "water" | "mountain" | "road"))
}
fn outcome(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(|value| matches!(value, "victory" | "defeat_wipe" | "defeat_timeout" | "defeat_buildings"))
}
fn skill(value: &str) -> bool { matches!(value, "smash" | "sweep" | "skip") }
fn cause(value: &str) -> bool { matches!(value, "occupied" | "target_gone" | "out_of_reach" | "not_adjacent" | "mech_dead" | "cooldown" | "other") }
fn action(value: &str) -> bool { matches!(value, "skip" | "melee" | "shoot" | "charge" | "pierce" | "repair") }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cell { x: f64, y: f64 }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArenaBuilding { id: String, cells: Vec<Cell>, x: f64, z: f64, yaw: f64, ground: f64, height: f64 }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Spawn { id: String, pos: Cell }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Arena {
    schema: String, arena_id: String, source_revision: String, ruleset: String,
    origin_x: f64, origin_z: f64, yaw: f64, cell_w: f64, cell_d: f64,
    terrain: Vec<Vec<String>>, heights: Vec<Vec<f64>>, buildings: Vec<ArenaBuilding>,
    blocked: Vec<Cell>, mechs: Vec<Spawn>, boss: Cell, raiders: Vec<Spawn>, spawn_spread: f64,
}
impl Arena {
    fn valid(&self) -> bool {
        let Some(shape) = self.arena_id.strip_prefix("city-") else { return false; };
        let Some(revision) = self.source_revision.strip_prefix(shape).and_then(|v| v.strip_prefix('-')) else { return false; };
        matches!(shape, "flat" | "shore" | "ridge" | "alley") && !revision.is_empty()
            && revision.len() <= 16 && revision.bytes().all(|b| b.is_ascii_digit())
            && self.schema == "mecha-arena:v1" && terrain(&self.terrain)
            && self.buildings.iter().all(|v| numeric_id(&v.id, "building-", 4))
            && self.mechs.iter().all(|v| mech(&v.id)) && self.raiders.iter().all(|v| raider(&v.id))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Building { id: String, cells: Vec<Cell>, hp: f64, max_hp: f64 }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent { skill_id: String, local: Vec<Cell>, projected: Vec<Cell>, cd_sweep: f64, status: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Mech { id: String, pos: Cell, hp: f64, cd: f64, skill_used: bool }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Raider { id: String, pos: Cell, hp: f64, intent: Option<Intent> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Boss { anchor: Cell, hp: f64, cd_sweep: f64, cadence: f64, intent: Option<Intent> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PveState {
    ruleset: String, preset: String, script: String, covers: Vec<Cell>, obstacles: Vec<Cell>,
    terrain: Vec<Vec<String>>, heights: Vec<Vec<f64>>, buildings: Vec<Building>, stake: String,
    raiders: Vec<Raider>, mechs: Vec<Mech>, boss: Boss, turn: f64, phase: String,
    revision: u64, outcome: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PvpUnit { id: String, side: String, kind: String, pos: Cell, hp: f64, cd: f64, skill_used: bool }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PvpState {
    ruleset: String, terrain: Vec<Vec<String>>, heights: Vec<Vec<f64>>, covers: Vec<Cell>,
    obstacles: Vec<Cell>, buildings: Vec<Building>, units: Vec<PvpUnit>, active_side: String,
    turn: f64, revision: u64, winner: Option<String>,
}
impl Intent {
    fn valid(&self) -> bool { skill(&self.skill_id) && matches!(self.status.as_str(), "planned" | "reprojected" | "void") }
}
impl PveState {
    fn valid(&self) -> bool {
        matches!(self.preset.as_str(), "covers_sparse_mid" | "covers_diag_corridor" | "covers_twin_clusters")
            && matches!(self.script.as_str(), "stationary_smash" | "cadence_ssw" | "raid_ssw" | "siege")
            && matches!(self.stake.as_str(), "all" | "frontage")
            && matches!(self.phase.as_str(), "enemy_prepare" | "player_plan" | "resolving_boss" | "finished")
            && outcome(&self.outcome) && terrain(&self.terrain)
            && self.buildings.iter().all(|v| building(&v.id)) && self.mechs.iter().all(|v| mech(&v.id))
            && self.raiders.iter().all(|v| raider(&v.id) && v.intent.as_ref().is_none_or(Intent::valid))
            && self.boss.intent.as_ref().is_none_or(Intent::valid)
    }
}
impl PvpState {
    fn valid(&self) -> bool {
        terrain(&self.terrain) && self.buildings.iter().all(|v| building(&v.id))
            && self.units.iter().all(|v| matches!(v.side.as_str(), "A" | "B") && mech(&v.kind) && v.id == format!("{}:{}", v.side, v.kind))
            && matches!(self.active_side.as_str(), "A" | "B")
            && self.winner.as_deref().is_none_or(|v| matches!(v, "A" | "B" | "draw"))
    }
}
#[derive(Deserialize)]
#[serde(untagged)]
enum State { Pve(Box<PveState>), Pvp(Box<PvpState>) }
impl State {
    fn matches(&self, ruleset: &str, revision: u64) -> bool {
        match self {
            Self::Pve(state) => ruleset == PVE && state.ruleset == PVE && state.revision == revision && state.valid(),
            Self::Pvp(state) => ruleset == PVP && state.ruleset == PVP && state.revision == revision && state.valid(),
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Player { player_id: String, side: String, role: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    protocol: String, match_id: String, mode: String, ruleset: String, status: String,
    revision: u64, players: Vec<Player>, arena: Arena, state: State,
}
impl Snapshot {
    fn valid(&self, match_id: &str) -> bool {
        self.protocol == NET && self.match_id == match_id && self.arena.valid()
            && matches!(self.status.as_str(), "active" | "finished" | "closed")
            && self.players.iter().all(|p| matches!((p.player_id.as_str(), p.side.as_str(), p.role.as_str()), ("owner", "A", "host") | ("guest", "B", "guest")))
            && self.arena.ruleset == self.ruleset && self.state.matches(&self.ruleset, self.revision)
            && matches!((self.mode.as_str(), self.ruleset.as_str()), ("pve", PVE) | ("pvp", PVP))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Effect { kind: String, id: String, before: f64, after: f64, order: f64, sequence: Option<f64> }
#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum TurnEvent {
    #[serde(rename = "move", rename_all = "camelCase")]
    Move { mech_id: String, from: Cell, to: Cell },
    #[serde(rename = "act", rename_all = "camelCase")]
    Act { mech_id: String, action: String, target: Option<String>, damage: f64, fizzled: Option<bool>, cause: Option<String>, effects: Option<Vec<Effect>> },
    #[serde(rename = "shove")]
    Shove { unit: String, dir: Cell, hit: Option<String>, damage: f64, effects: Option<Vec<Effect>>, sequence: Option<f64> },
    #[serde(rename = "enemy")]
    Enemy { actor: String, skill: String, cells: Vec<Cell>, damage: f64, effects: Option<Vec<Effect>> },
    #[serde(rename = "outcome")]
    Outcome { outcome: String },
}
impl Effect {
    fn valid(&self) -> bool {
        match self.kind.as_str() {
            "boss" => self.id == "boss", "mech" => mech(&self.id),
            "raider" => raider(&self.id) || unit(&self.id), "building" => building(&self.id), _ => false,
        }
    }
}
impl TurnEvent {
    fn valid(&self) -> bool {
        let effects = |items: &Option<Vec<Effect>>| items.as_ref().is_none_or(|items| items.iter().all(Effect::valid));
        match self {
            Self::Move { mech_id, .. } => mech(mech_id),
            Self::Act { mech_id, action: kind, target, cause: reason, effects: items, .. } => mech(mech_id)
                && action(kind) && target.as_deref().is_none_or(unit) && reason.as_deref().is_none_or(cause) && effects(items),
            Self::Shove { unit: id, hit, effects: items, .. } => (id == "boss" || mech(id))
                && hit.as_deref().is_none_or(|v| v.split(',').all(|part| matches!(part, "wall" | "raider" | "building" | "rubble" | "obstacle" | "cover") || unit(part))) && effects(items),
            Self::Enemy { actor, skill: kind, effects: items, .. } => (actor == "boss" || raider(actor)) && skill(kind) && effects(items),
            Self::Outcome { outcome: value } => outcome(&Some(value.clone())),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PresentationBoss { anchor: Cell, hp: f64 }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PresentationUnit { id: String, pos: Cell, hp: f64 }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PresentationBuilding { id: String, hp: f64 }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Presentation { boss: PresentationBoss, mechs: Vec<PresentationUnit>, raiders: Vec<PresentationUnit>, buildings: Vec<PresentationBuilding>, outcome: Option<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PresentationStages { before: Presentation, after_movement: Presentation, after_player: Presentation, after_enemy: Presentation, after_prepare: Presentation }
impl Presentation {
    fn valid(&self) -> bool {
        outcome(&self.outcome) && self.mechs.iter().all(|v| mech(&v.id))
            && self.raiders.iter().all(|v| raider(&v.id) || unit(&v.id))
            && self.buildings.iter().all(|v| building(&v.id))
    }
}
impl PresentationStages {
    fn valid(&self) -> bool {
        self.before.valid() && self.after_movement.valid() && self.after_player.valid()
            && self.after_enemy.valid() && self.after_prepare.valid()
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Turn {
    #[serde(rename = "type")]
    kind: String, protocol: String, match_id: String, player_id: String, command_id: String,
    revision: u64, state: State, log: Vec<TurnEvent>, presentation_stages: Option<PresentationStages>,
}
impl Turn {
    fn valid(&self, match_id: &str) -> bool {
        self.kind == "turn.resolved" && self.protocol == NET && self.match_id == match_id
            && matches!(self.player_id.as_str(), "owner" | "guest") && identifier(&self.command_id)
            && self.log.iter().all(TurnEvent::valid) && self.presentation_stages.as_ref().is_none_or(PresentationStages::valid)
            && (self.state.matches(PVE, self.revision) || self.state.matches(PVP, self.revision))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fault { code: String, #[serde(rename = "mechId")] mech_id: Option<String>, cause: Option<String> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Error { code: String, fault: Option<Fault> }
impl Error {
    fn valid(&self) -> bool {
        matches!(self.code.as_str(), "unauthenticated" | "forbidden" | "not_your_turn" | "stale_revision"
            | "duplicate_command" | "invalid_plan" | "invalid_message" | "message_too_large" | "match_not_found"
            | "match_finished" | "room_closed" | "host_offline" | "ruleset_mismatch" | "rate_limited" | "unavailable")
            && self.fault.as_ref().is_none_or(|v| matches!(v.code.as_str(), "PLAN_PACK_REJECTED" | "NEED_ALL_OR_CONFIRM" | "STALE_REVISION")
                && v.mech_id.as_deref().is_none_or(mech) && v.cause.as_deref().is_none_or(cause))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Failure { ok: bool, error: Error }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Success<T> { ok: bool, value: T }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Response<T> { protocol: String, #[serde(rename = "type")] kind: String, request_id: String, result: T }
#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum Event {
    #[serde(rename = "match.closed", rename_all = "camelCase")]
    Closed { match_id: String, revision: u64 },
    #[serde(rename = "match.replaced")]
    Replaced { snapshot: Box<Snapshot> },
    #[serde(rename = "turn.resolved")]
    Resolved { result: Box<Turn> },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Notification { protocol: String, #[serde(rename = "type")] kind: String, event: Event }


// Reject extra command fields before game logic can copy a remote coordinate
// into state. Otherwise an invalid outgoing event would leave the host advanced
// but the peers unable to observe the new revision.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action { kind: String, target: Option<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Order { mech_id: String, move_to: Option<Cell>, action: Action }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan { revision: u64, items: Vec<Order> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubmitPlan {
    #[serde(rename = "type")]
    kind: String, protocol: String, match_id: String, player_id: String,
    command_id: String, base_revision: u64, plan: Plan,
}
pub(super) fn valid_submit_plan(payload: &Value) -> bool {
    serde_json::from_value::<SubmitPlan>(payload.clone()).is_ok()
}

pub(super) fn valid_start(arena: &Value, state: &Value) -> bool {
    let Ok(arena) = serde_json::from_value::<Arena>(arena.clone()) else { return false; };
    let Ok(state) = serde_json::from_value::<PveState>(state.clone()) else { return false; };
    arena.valid() && arena.ruleset == PVE && state.ruleset == PVE && state.valid()
}

// Validate the actual bytes about to leave the trusted host, not just the input
// to match.create. Both game modes can produce snapshots and turn events, and
// game logic may copy fields from a remote command into a later state.
pub(super) fn valid_outbound(message: &Value, match_id: &str) -> bool {
    match message["type"].as_str() {
        Some("event") => {
            let Ok(message) = serde_json::from_value::<Notification>(message.clone()) else { return false; };
            message.protocol == NET && message.kind == "event" && match message.event {
                Event::Closed { match_id: id, .. } => id == match_id,
                Event::Replaced { snapshot } => snapshot.valid(match_id),
                Event::Resolved { result } => result.valid(match_id),
            }
        }
        Some("response") if message["result"]["ok"] == false => {
            serde_json::from_value::<Response<Failure>>(message.clone()).is_ok_and(|response|
                response.protocol == NET && response.kind == "response" && !response.result.ok && response.result.error.valid())
        }
        Some("response") if message["result"]["ok"] == true => {
            if let Ok(response) = serde_json::from_value::<Response<Success<Snapshot>>>(message.clone()) {
                return response.protocol == NET && response.kind == "response" && response.result.ok && response.result.value.valid(match_id);
            }
            serde_json::from_value::<Response<Success<Turn>>>(message.clone()).is_ok_and(|response|
                response.protocol == NET && response.kind == "response" && response.result.ok && response.result.value.valid(match_id))
        }
        _ => false,
    }
}

#[cfg(test)]
#[path = "remote_gateway_projection_tests.rs"]
mod tests;
