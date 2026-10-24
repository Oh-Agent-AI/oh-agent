//! Geometry. GDD §3.2 / §9.1: 2×2 center is `anchor + (1,1)`, never `+0.5`.

use crate::{BOARD_H, BOARD_W};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Cell {
    pub x: i8,
    pub y: i8,
}

impl Cell {
    pub const fn new(x: i8, y: i8) -> Self {
        Cell { x, y }
    }

    pub fn in_bounds(self) -> bool {
        self.x >= 0 && self.x < BOARD_W && self.y >= 0 && self.y < BOARD_H
    }

    pub fn translate(self, dir: Dir) -> Cell {
        Cell {
            x: self.x + dir.dx,
            y: self.y + dir.dy,
        }
    }

    pub fn offset(self, o: Offset) -> Cell {
        Cell {
            x: self.x + o.dx,
            y: self.y + o.dy,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Offset {
    pub dx: i8,
    pub dy: i8,
}

impl Offset {
    pub const fn new(dx: i8, dy: i8) -> Self {
        Offset { dx, dy }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Dir {
    pub dx: i8,
    pub dy: i8,
}

impl Dir {
    pub const N: Dir = Dir { dx: 0, dy: -1 };
    pub const E: Dir = Dir { dx: 1, dy: 0 };
    pub const S: Dir = Dir { dx: 0, dy: 1 };
    pub const W: Dir = Dir { dx: -1, dy: 0 };
    pub const CARDINALS: [Dir; 4] = [Dir::N, Dir::E, Dir::S, Dir::W];
}

/// 2×2 footprint NW-anchored: `(0,0)(1,0)(0,1)(1,1)` relative.
pub fn footprint(anchor: Cell) -> [Cell; 4] {
    [
        anchor,
        Cell::new(anchor.x + 1, anchor.y),
        Cell::new(anchor.x, anchor.y + 1),
        Cell::new(anchor.x + 1, anchor.y + 1),
    ]
}

/// Geometric center of the 2×2. `+0.5` would be the NW cell center — forbidden.
pub fn footprint_center(anchor: Cell) -> (f64, f64) {
    (anchor.x as f64 + 1.0, anchor.y as f64 + 1.0)
}

/// 1×1 cell center. `+0.5` is correct here.
pub fn attacker_center(cell: Cell) -> (f64, f64) {
    (cell.x as f64 + 0.5, cell.y as f64 + 0.5)
}

fn signi(v: f64) -> i8 {
    if v > 0.0 {
        1
    } else if v < 0.0 {
        -1
    } else {
        0
    }
}

/// Lock D: equal |dx|/|dy| prefers the horizontal axis.
pub fn primary_axis(dx: f64, dy: f64) -> Dir {
    let ax = dx.abs();
    let ay = dy.abs();
    if ax > ay {
        Dir {
            dx: signi(dx),
            dy: 0,
        }
    } else if ay > ax {
        Dir {
            dx: 0,
            dy: signi(dy),
        }
    } else {
        Dir {
            dx: signi(dx),
            dy: 0,
        }
    }
}

/// Knockback of the Boss: from attacker toward Boss center.
pub fn knockback_dir_from_attacker(attacker: Cell, boss_anchor: Cell) -> Dir {
    let (fx, fy) = footprint_center(boss_anchor);
    let (ax, ay) = attacker_center(attacker);
    primary_axis(fx - ax, fy - ay)
}

/// Knockback of a 1×1: from Boss center toward the target center.
pub fn knockback_dir_from_boss(boss_anchor: Cell, target: Cell) -> Dir {
    let (fx, fy) = footprint_center(boss_anchor);
    let (tx, ty) = attacker_center(target);
    primary_axis(tx - fx, ty - fy)
}

pub fn chebyshev(a: Cell, b: Cell) -> i8 {
    (a.x - b.x).abs().max((a.y - b.y).abs())
}

pub fn manhattan(a: Cell, b: Cell) -> i8 {
    (a.x - b.x).abs() + (a.y - b.y).abs()
}

pub fn occupies_footprint(anchor: Cell, cell: Cell) -> bool {
    cell.x >= anchor.x && cell.x <= anchor.x + 1 && cell.y >= anchor.y && cell.y <= anchor.y + 1
}

/// Chebyshev=1 to the 2×2 and not overlapping it (edge or corner).
pub fn adjacent_to_footprint(anchor: Cell, cell: Cell) -> bool {
    if occupies_footprint(anchor, cell) {
        return false;
    }
    footprint(anchor).iter().any(|f| chebyshev(*f, cell) == 1)
}

pub fn adjacent_cells(anchor: Cell) -> Vec<Cell> {
    let mut out = Vec::new();
    for y in (anchor.y - 1)..=(anchor.y + 2) {
        for x in (anchor.x - 1)..=(anchor.x + 2) {
            let c = Cell::new(x, y);
            if c.in_bounds() && adjacent_to_footprint(anchor, c) {
                out.push(c);
            }
        }
    }
    out
}
