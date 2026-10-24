//! Named cover presets. Coordinates land in `match_seed.board.covers`.
//! No Arena terrain families (码头/广场) — those stay P2.

use crate::geom::Cell;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CoverPreset {
    /// Mid-axis ~2–3 covers.
    SparseMid,
    /// Diagonal wall with a parallel corridor.
    DiagCorridor,
    /// Two clumps of cover, west and east.
    TwinClusters,
}

impl CoverPreset {
    pub const ALL: [CoverPreset; 3] = [
        CoverPreset::SparseMid,
        CoverPreset::DiagCorridor,
        CoverPreset::TwinClusters,
    ];

    pub fn id(self) -> &'static str {
        match self {
            CoverPreset::SparseMid => "covers_sparse_mid",
            CoverPreset::DiagCorridor => "covers_diag_corridor",
            CoverPreset::TwinClusters => "covers_twin_clusters",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "covers_sparse_mid" => Some(CoverPreset::SparseMid),
            "covers_diag_corridor" => Some(CoverPreset::DiagCorridor),
            "covers_twin_clusters" => Some(CoverPreset::TwinClusters),
            _ => None,
        }
    }

    pub fn cells(self) -> &'static [Cell] {
        match self {
            CoverPreset::SparseMid => &COVERS_SPARSE_MID,
            CoverPreset::DiagCorridor => &COVERS_DIAG_CORRIDOR,
            CoverPreset::TwinClusters => &COVERS_TWIN_CLUSTERS,
        }
    }
}

/// Mid-board axis, 3 covers (GDD 中轴 2–3).
pub const COVERS_SPARSE_MID: [Cell; 3] = [
    Cell { x: 4, y: 4 },
    Cell { x: 5, y: 4 },
    Cell { x: 4, y: 5 },
];

/// Staircase diagonal; corridor is the parallel empty diagonal.
pub const COVERS_DIAG_CORRIDOR: [Cell; 5] = [
    Cell { x: 2, y: 3 },
    Cell { x: 3, y: 4 },
    Cell { x: 4, y: 5 },
    Cell { x: 5, y: 6 },
    Cell { x: 6, y: 7 },
];

/// West clump + east clump.
pub const COVERS_TWIN_CLUSTERS: [Cell; 6] = [
    Cell { x: 1, y: 4 },
    Cell { x: 2, y: 4 },
    Cell { x: 2, y: 5 },
    Cell { x: 7, y: 4 },
    Cell { x: 8, y: 4 },
    Cell { x: 7, y: 5 },
];
