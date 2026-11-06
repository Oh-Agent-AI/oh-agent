"""Trust finding contract lockstep.

The fixture is deliberately redacted: no actor, workspace, hostname, path, or
source anchor is present. Python mirrors the rule boundaries while the Rust
correlator consumes the same fixture in its unit contract test.
"""

import json
import unittest
from pathlib import Path


FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "trust" / "correlation_cases.json"
CHAIN_FIXTURES = [
    Path(__file__).resolve().parents[1] / "fixtures" / "trust" / "zcode_complete_chain.json",
    Path(__file__).resolve().parents[1] / "fixtures" / "trust" / "minimax_missing_chain.json",
]


def python_projection(case):
    rows = case["observations"]
    kinds = []
    if any(row["stage"] == "package_observed" and "git_history" in row["scope_classes"] for row in rows):
        kinds.append("SV702")
    if any(
        row["consent_state"] == "disabled"
        and row["consent_kind"]
        and row["evidence_level"] in {"E2", "E3", "E4", "E5"}
        for row in rows
    ):
        kinds.append("SV705")
    prepared = any(
        row["stage"] == "credential_observed" or row["destination_class"] == "vendor_api"
        for row in rows
    )
    object_storage = any(
        row["destination_class"] == "object_storage"
        and row["evidence_level"] in {"E3", "E4", "E5"}
        and row["stage"] != "credential_observed"
        for row in rows
    )
    if prepared and object_storage:
        kinds.append("SV709")
    return {"finding_types": kinds, "evidence_links": len(rows) * len(kinds)}


class TrustCorrelatorLockstep(unittest.TestCase):
    def test_redacted_fixture_matches_expected_contract(self):
        payload = json.loads(FIXTURE.read_text())
        self.assertEqual(payload["schema_version"], "trust-correlation-v1")
        for case in payload["cases"]:
            self.assertEqual(python_projection(case), case["expected"], case["id"])

    def test_harness_chain_fixtures_are_redacted_and_do_not_overclaim_acceptance(self):
        for path in CHAIN_FIXTURES:
            payload = json.loads(path.read_text())
            self.assertEqual(payload["schema_version"], "trust-egress-fixture-v1")
            encoded = path.read_text()
            for forbidden in ("/Users/", ".git/objects", "Authorization", "signature"):
                self.assertNotIn(forbidden, encoded)
            self.assertFalse(payload["expected"]["remote_accepted"])


if __name__ == "__main__":
    unittest.main()
