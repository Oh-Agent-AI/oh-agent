// Remote match wire contracts. Keep these in sync with the versioned City
// contracts in game/mecha/{contracts,board.ts}. Deserialization
// is deliberately strict at every object boundary: accepting an opaque Value
// here would allow local data to escape through a nested extension field.
#![allow(dead_code)]
use serde::Deserialize;
use serde_json::Value;

const PVE: &str = "mecha-v1.4";
const SEQUENTIAL_PVE: &str = "mecha-v1.5";
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
struct TerrainEdge { from: Cell, to: Cell }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerrainSafety { unsafe_cells: Vec<Cell>, unsafe_edges: Vec<TerrainEdge> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Deployment { zone: Vec<Cell>, reserved_cells: Vec<Cell> }
fn deserialize_deployment<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Deployment>, D::Error> {
    Deployment::deserialize(deserializer).map(Some)
}
impl Cell {
    fn board_cell(&self) -> bool {
        self.x >= 0.0 && self.x < 10.0 && self.x.fract() == 0.0
            && self.y >= 0.0 && self.y < 10.0 && self.y.fract() == 0.0
    }
}
impl Deployment {
    fn valid(&self) -> bool {
        fn unique(cells: &[Cell]) -> bool {
            cells.iter().enumerate().all(|(index, cell)| cell.board_cell()
                && !cells[..index].iter().any(|other| cell.x == other.x && cell.y == other.y))
        }
        self.zone.len() <= 100 && self.reserved_cells.len() <= 100
            && unique(&self.zone) && unique(&self.reserved_cells)
    }
}
impl TerrainSafety {
    fn valid(&self) -> bool {
        self.unsafe_cells.len() <= 100 && self.unsafe_cells.iter().all(Cell::board_cell)
            && self.unsafe_edges.len() <= 342 && self.unsafe_edges.iter().all(|edge| {
                edge.from.board_cell() && edge.to.board_cell()
                    && (edge.from.x - edge.to.x).abs() <= 1.0 && (edge.from.y - edge.to.y).abs() <= 1.0
                    && (edge.from.x != edge.to.x || edge.from.y != edge.to.y)
            })
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PveState {
    ruleset: String, preset: String, script: String, covers: Vec<Cell>, obstacles: Vec<Cell>,
    terrain: Vec<Vec<String>>, heights: Vec<Vec<f64>>, buildings: Vec<Building>, stake: String,
    raiders: Vec<Raider>, mechs: Vec<Mech>, boss: Boss, turn: f64, phase: String,
    revision: u64, outcome: Option<String>,
    assault_terrain_safety: Option<TerrainSafety>,
    #[serde(default, deserialize_with = "deserialize_deployment")]
    deployment: Option<Deployment>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SequentialPlacement { #[serde(rename = "mechId")] mech_id: String, pos: Cell }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SequentialAction { kind: String, target: Option<String> }
#[derive(Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum SequentialCommand {
    #[serde(rename = "move")]
    Move { id: String, revision: u64, mech: String, to: Cell },
    #[serde(rename = "undo")]
    Undo { id: String, revision: u64 },
    #[serde(rename = "act")]
    Act { id: String, revision: u64, mech: String, action: SequentialAction },
    #[serde(rename = "reset")]
    Reset { id: String, revision: u64 },
    #[serde(rename = "end")]
    End { id: String, revision: u64, #[serde(rename = "confirmUnused")] confirm_unused: bool },
}
impl SequentialCommand {
    fn valid(&self) -> bool {
        let valid_command_id = |value: &str| !value.is_empty() && value.len() <= 128
            && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'));
        match self {
            Self::Move { id, revision, mech: id_mech, to } => valid_command_id(id) && *revision <= 9_007_199_254_740_991 && mech(id_mech) && to.board_cell(),
            Self::Undo { id, revision } | Self::Reset { id, revision } => valid_command_id(id) && *revision <= 9_007_199_254_740_991,
            Self::Act { id, revision, mech: id_mech, action: value } => valid_command_id(id) && *revision <= 9_007_199_254_740_991
                && mech(id_mech) && matches!(value.kind.as_str(), "skip" | "melee" | "shoot" | "charge" | "pierce" | "repair")
                && value.target.as_deref().is_none_or(|target| !target.is_empty() && target.len() <= 128
                    && target.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-')))
                && (value.kind != "skip" || value.target.is_none())
                && (value.kind != "repair" || value.target.as_deref().is_some_and(mech)),
            Self::End { id, revision, .. } => valid_command_id(id) && *revision <= 9_007_199_254_740_991,
        }
    }
    fn identity(&self) -> (&str, u64) {
        match self {
            Self::Move { id, revision, .. } | Self::Undo { id, revision } | Self::Act { id, revision, .. }
            | Self::Reset { id, revision } | Self::End { id, revision, .. } => (id, *revision),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SequentialOpening { initial: PveState, placements: Vec<SequentialPlacement>, commands: Vec<SequentialCommand> }
impl SequentialOpening {
    fn valid(&self) -> bool {
        if self.initial.ruleset != SEQUENTIAL_PVE || !self.initial.common_valid() || self.initial.phase != "player_plan"
            || self.initial.outcome.is_some() || self.initial.deployment.is_some() || self.initial.mechs.len() != 3
            || self.initial.revision > 9_007_199_254_740_991 || self.placements.len() != 3 || self.commands.len() > 4096 { return false; }
        let mut placement_ids = std::collections::BTreeSet::new();
        for placement in &self.placements {
            if !mech(&placement.mech_id) || !placement.pos.board_cell() || !placement_ids.insert(placement.mech_id.as_str())
                || self.initial.mechs.iter().filter(|unit| unit.id == placement.mech_id && unit.pos.x == placement.pos.x && unit.pos.y == placement.pos.y).count() != 1 { return false; }
        }
        if ["Assault", "Gunner", "Support"].iter().any(|id| self.initial.mechs.iter().filter(|unit| &unit.id == id).count() != 1) { return false; }
        let mut command_ids = std::collections::BTreeSet::new();
        for (index, command) in self.commands.iter().enumerate() {
            let (id, revision) = command.identity();
            if !command.valid() || !command_ids.insert(id) || revision != self.initial.revision + index as u64 { return false; }
        }
        self.initial.revision.checked_add(self.commands.len() as u64).is_some()
    }
}
impl Intent {
    fn valid(&self) -> bool { skill(&self.skill_id) && matches!(self.status.as_str(), "planned" | "reprojected" | "void") }
}
impl PveState {
    fn common_valid(&self) -> bool {
        matches!(self.preset.as_str(), "covers_sparse_mid" | "covers_diag_corridor" | "covers_twin_clusters")
            && matches!(self.script.as_str(), "stationary_smash" | "cadence_ssw" | "raid_ssw" | "siege")
            && matches!(self.stake.as_str(), "all" | "frontage")
            && outcome(&self.outcome) && terrain(&self.terrain)
            && self.assault_terrain_safety.as_ref().is_none_or(TerrainSafety::valid)
            && self.buildings.iter().all(|v| building(&v.id)) && self.mechs.iter().all(|v| mech(&v.id))
            && self.raiders.iter().all(|v| raider(&v.id) && v.intent.as_ref().is_none_or(Intent::valid))
            && self.boss.intent.as_ref().is_none_or(Intent::valid)
    }
    fn valid(&self) -> bool {
        self.common_valid() && self.deployment.is_none()
            && matches!(self.phase.as_str(), "enemy_prepare" | "player_plan" | "resolving_boss" | "finished")
    }
    // Deployment is a distinct v2 state and cannot carry enemy intents.
    fn valid_deployment(&self) -> bool {
        self.common_valid() && self.phase == "deployment" && self.outcome.is_none()
            && self.deployment.as_ref().is_some_and(Deployment::valid)
            && self.boss.intent.is_none() && self.raiders.iter().all(|v| v.intent.is_none())
            && self.mechs.len() == 3 && ["Assault", "Gunner", "Support"].iter()
                .all(|id| self.mechs.iter().filter(|mech| &mech.id == id).count() == 1)
    }
}
#[derive(Deserialize)]
#[serde(untagged)]
enum State { Pve(Box<PveState>) }
impl State {
    fn matches(&self, ruleset: &str, revision: u64) -> bool {
        match self {
            Self::Pve(state) => ruleset == PVE && state.ruleset == PVE && state.revision == revision && state.valid(),
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
            && self.mode == "pve" && self.ruleset == PVE
    }
    // Only a single owner may view an active or closed PvE deployment.
    fn valid_deployment(&self, match_id: &str) -> bool {
        self.protocol == NET && self.match_id == match_id && self.mode == "pve" && self.ruleset == PVE
            && matches!(self.status.as_str(), "active" | "closed") && self.arena.valid() && self.arena.ruleset == PVE
            && self.players.len() == 1 && matches!((self.players[0].player_id.as_str(), self.players[0].side.as_str(), self.players[0].role.as_str()), ("owner", "A", "host"))
            && matches!(&self.state, State::Pve(state) if state.ruleset == PVE && state.revision == self.revision && state.valid_deployment())
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
            && self.state.matches(PVE, self.revision)
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

// The v3 concession carries no opaque extensions, and must use JS-safe revisions.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubmitConcede {
    #[serde(rename = "type")]
    kind: String, protocol: String, match_id: String, player_id: String,
    command_id: String, base_revision: u64,
}
pub(super) fn valid_submit_concede(payload: &Value) -> bool {
    serde_json::from_value::<SubmitConcede>(payload.clone()).is_ok_and(|command|
        command.kind == "match.concede-v2" && command.protocol == NET
            && identifier(&command.match_id) && matches!(command.player_id.as_str(), "owner" | "guest")
            && identifier(&command.command_id) && command.base_revision <= 9_007_199_254_740_991)
}

// Validate every nested deployment command before authority state can change.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeployPlacement { mech_id: String, pos: Cell }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeployPlan { revision: u64, placements: Vec<DeployPlacement> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubmitDeployment {
    #[serde(rename = "type")]
    kind: String, protocol: String, match_id: String, player_id: String,
    command_id: String, base_revision: u64, plan: DeployPlan,
}
pub(super) fn valid_submit_deployment(payload: &Value) -> bool {
    serde_json::from_value::<SubmitDeployment>(payload.clone()).is_ok_and(|command|
        command.kind == "deployment.submit" && command.protocol == NET
            && identifier(&command.match_id) && command.player_id == "owner" && identifier(&command.command_id)
            && command.plan.revision == command.base_revision && command.plan.placements.len() <= 3
            && command.plan.placements.iter().all(|p| mech(&p.mech_id) && p.pos.board_cell()))
}
pub(super) fn valid_start_deployment(arena: &Value, state: &Value) -> bool {
    let Ok(arena) = serde_json::from_value::<Arena>(arena.clone()) else { return false; };
    let Ok(state) = serde_json::from_value::<PveState>(state.clone()) else { return false; };
    arena.valid() && arena.ruleset == PVE && state.ruleset == PVE && state.valid_deployment()
}

pub(super) fn valid_start(arena: &Value, state: &Value) -> bool {
    let Ok(arena) = serde_json::from_value::<Arena>(arena.clone()) else { return false; };
    let Ok(state) = serde_json::from_value::<PveState>(state.clone()) else { return false; };
    arena.valid() && arena.ruleset == PVE && state.ruleset == PVE && state.valid()
}

pub(super) fn valid_start_sequential(opening: &Value) -> bool {
    serde_json::from_value::<SequentialOpening>(opening.clone()).is_ok_and(|opening| opening.valid())
}

// v2 also permits explicitly validated deployment snapshots and faults.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeploymentFault {
    code: String,
    #[serde(rename = "mechId", default, deserialize_with = "deserialize_optional_mech")]
    mech_id: Option<String>,
}
fn deserialize_optional_mech<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeploymentError { code: String, fault: DeploymentFault }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeploymentFailure { ok: bool, error: DeploymentError }

pub(super) fn valid_outbound_with_deployment(message: &Value, match_id: &str) -> bool {
    if valid_outbound(message, match_id) { return true; }
    match message["type"].as_str() {
        Some("event") => serde_json::from_value::<Notification>(message.clone()).is_ok_and(|message|
            message.protocol == NET && message.kind == "event" && matches!(message.event,
                Event::Replaced { snapshot } if snapshot.valid_deployment(match_id))),
        Some("response") if message["result"]["ok"] == true =>
            serde_json::from_value::<Response<Success<Snapshot>>>(message.clone()).is_ok_and(|response|
                response.protocol == NET && response.kind == "response" && response.result.ok
                    && response.result.value.valid_deployment(match_id)),
        Some("response") if message["result"]["ok"] == false =>
            serde_json::from_value::<Response<DeploymentFailure>>(message.clone()).is_ok_and(|response|
                response.protocol == NET && response.kind == "response" && !response.result.ok
                    && response.result.error.code == "invalid_deployment"
                    && matches!(response.result.error.fault.code.as_str(), "phase" | "revision" | "incomplete" | "duplicate_mech"
                        | "invalid_cell" | "outside_zone" | "terrain" | "unsafe" | "occupied" | "reserved" | "duplicate_cell" | "insufficient_space")
                    && response.result.error.fault.mech_id.as_deref().is_none_or(mech)),
        _ => false,
    }
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
