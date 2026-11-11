# Mecha v1.5: Per-Mech Pending Movement Undo

Date: 2026-11-07  
Status: Implemented; verification passed on 2026-11-07
Scope: Local v1.5 sequential turn authority and its shared HUD adapter

## 1. Problem

The current v1.5 contract gives each living mech one voluntary move and one action per turn. A move resolves immediately. A mech may reconsider its destination until that same mech commits an action.

The new test screenshot shows Support with `Move — · Act ✓`, while the `Undo move` button is disabled. Support has already moved, but has not acted. It should still be possible to undo that move and choose another destination.

The state machine stores undo history as one global LIFO list in `Snapshot.undo`. Every successful action clears that entire list. As a result, Assault or Gunner acting also clears Support's pending move undo. The HUD reads that list to decide whether undo is available, so it disables the button and leaves the player with the first destination even when the moved mech still has its action available.

This violates the v1.5/Into the Breach turn contract already recorded in `MECHA_ITB_ALIGNMENT_ARCH_2026_11_07.md`: movement is undoable until the moved mech acts.

## 2. Goals

1. Keep each mech's committed move undoable until that mech commits an action.
2. Allow a player to move a different mech and commit its action without locking other mechs' unacted moves.
3. Keep undo deterministic: the `undo` command reverts the latest currently eligible move.
4. Keep the v1.5 command shape, remote protocol, checkpoint/replay schema, and serialized snapshot fields unchanged.
5. Keep move/action rights authoritative in `SequentialTurn`; expose undo availability through the controller for the HUD.
6. Explain when a move has been spent and whether an undo or the one-time turn reset is available.

## 3. Non-Goals

- Do not change movement range, action range, damage, status values, turn order, or victory rules.
- Do not allow a mech to move twice without undoing its first move.
- Do not change the v1.4 UI or its planning rules.
- Do not add a mech identifier to the `undo` command or change `mecha-net:v1`.
- Do not add fields or versions to saved replay/checkpoint formats.

## 4. Required State-Machine Behavior

### 4.1 Pending move eligibility

A committed move is eligible for undo when all of the following are true:

- The moved mech is alive.
- That mech still has its action right.
- The mech remains at the committed destination.
- The original source cell is empty. Another unit can occupy it after a committed push.

The command authority selects the newest eligible move when handling the existing `{ kind: "undo" }` command. Ineligible stale entries must not prevent an older eligible move from being undone.

### 4.2 Command transitions

| Command | Pending movement undo behavior |
| --- | --- |
| `move(A)` | Record A's source and destination; consume only A's move right. |
| `act(A)` | Remove A's pending move undo; preserve eligible pending moves for other mechs. |
| `undo` | Revert the newest eligible move, restore that mech's move right, preserve its action right. |
| `reset` | Restore the turn checkpoint and its pending undo state; consume the existing one-time reset. |
| `end` | Clear pending movement undo before the next player phase. |
| Winning move/action | Clear pending movement undo because the match is finished. |
| Forced displacement/death | Invalidate that mech's candidate if it is dead or no longer at the recorded destination. |

Undoing and then moving the same mech again creates a fresh candidate. This supports repeated destination experimentation without granting extra movement after an action.

## 5. Replay and Compatibility Contract

`Snapshot.undo` is already part of serialized replay evidence. Its field and legacy serialized behavior must remain unchanged so existing records continue to verify.

The authority may keep an internal, non-serialized pending-move index. It must be derivable by replaying the existing ordered commands; it must not be persisted as a new field. `trial()` must copy this internal index, while `SequentialTurn.replay()` must reconstruct it by applying the command stream.

Regression acceptance requires both:

- Previously valid records retain identical `snapshot.undo` shape/content and still replay successfully.
- A new sequence `move(Support) → act(Gunner) → undo` replays successfully, restores Support's source cell, and restores only Support's move right.

No hashes, command IDs, causal event fields, checkpoint versions, or replay envelope fields change.

## 6. Controller and HUD Behavior

- `SequentialTurn.undoMech()` identifies the actor of the latest eligible undo.
- The panel enables `Undo move` only when the selected mech is that actor. If another mech is next, it names the mech to select.
- The controller validates the requested actor against the current selection and authority before issuing the existing actorless replay command.
- Action previews are scoped to the selected actor and board revision. Both modes share the target binding and board projection used by classic play.
- When movement remains available but no destination is reachable, the HUD keeps the separate “no reachable cells” explanation.

The selection controls remain unchanged: a unit with spent movement has no movement destinations; after undo restores its move right, its legal destinations reappear.

## 7. Acceptance Tests

### Rules and command history

1. Move Support, act with Gunner, then undo: Support returns to its source, `Support.move` becomes true, and `Support.action` stays true.
2. After Support acts, its move is no longer undoable.
3. With multiple eligible moves, undo chooses the newest eligible one; an ineligible latest record does not block an earlier eligible move.
4. Occupied source cells, dead units, and units displaced from their recorded destination cannot be undone.
5. Reset/end/victory clear pending undo according to §4.2.
6. `trial()` remains isolated and replay reconstructs pending undo from commands.
7. Existing replay fixtures retain their serialized `Snapshot.undo` data and pass verification.
8. Move Gunner, then move and act with Assault. Undo from Assault's panel is rejected without changing either unit. Selecting Gunner enables its undo. A stale request from Assault still fails.

### Browser flow

Run the following in both Chinese desktop and English mobile viewports:

1. Deploy and confirm.
2. Move Support.
3. Move Gunner and confirm a legal shot.
   Before confirming, switch to Assault and back. Neither panel may confirm the abandoned target preview. Pick the target again on Gunner.
4. Verify Gunner's panel cannot undo Support's move. Select Support and verify undo is enabled.
5. Undo Support's move, verify its source position and movement destinations return.
6. Move Support to a new destination and act.
7. Verify Support's undo becomes unavailable after Support acts.

## 8. Verification and Delivery

- `cd apps/agent-city/ui && npm run typecheck`
- `cd apps/agent-city/ui && npm run verify:mecha`
- `node scripts/verify-mecha-v15-browser.mjs http://127.0.0.1:5187`
- `MECHA_V15_LOCALE=en node scripts/verify-mecha-v15-browser.mjs http://127.0.0.1:5187`
- Capture the cross-mech undo state and the post-action locked state for review.
- Do not push as part of this fix. Package only after the source and browser acceptance checks pass.

## 9. Evidence From the Reported State

The user screenshot shows the current turn with Support's movement right spent and action right available; its action cards show `Hold: Ready` and the other targeted actions unavailable. The same screenshot shows the undo control disabled. This combination identifies loss of a pending movement undo, rather than an unreachable path or an action-right restriction.
