"""汇率同步规则（scripts/fx_sync.py）：两源一致才采用、整份拒绝的条件、不让 captured_at 单独制造提交。"""
import datetime as dt
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fx_sync", ROOT / "scripts" / "fx_sync.py")
fx_sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx_sync)


def pair(date="2026-10-01", ecb=None, fawaz=None):
    return (date, ecb or {"CNY": 6.7, "EUR": 0.88, "JPY": 157.0}), (date, fawaz or {"CNY": 6.705, "EUR": 0.881, "JPY": 157.1, "AED": 3.67})


class MergeTests(unittest.TestCase):
    def test_only_currencies_both_sources_agree_on_are_adopted(self):
        date, adopted, rejected, single = fx_sync.merge(*pair())
        self.assertEqual(date, "2026-10-01")
        self.assertEqual(set(adopted), {"CNY", "EUR", "JPY", "USD"})
        self.assertEqual(adopted["USD"], "1")
        self.assertEqual(rejected, {})
        self.assertNotIn("AED", adopted, "a currency only the second source has is never published")

    def test_disagreeing_currencies_are_listed_and_not_adopted(self):
        a, b = pair(fawaz={"CNY": 6.7, "EUR": 0.95, "JPY": 157.0})
        _, adopted, rejected, _ = fx_sync.merge(a, b)
        self.assertNotIn("EUR", adopted)
        self.assertIn("EUR", rejected)
        self.assertIn("CNY", adopted)

    def test_sources_on_different_dates_are_refused(self):
        with self.assertRaises(ValueError):
            fx_sync.merge(("2026-10-01", {"CNY": 6.7}), ("2026-09-30", {"CNY": 6.7}))

    def test_a_non_usd_base_is_refused(self):
        with self.assertRaises(ValueError):
            fx_sync.parse_ecb({"base": "EUR", "date": "2026-10-01", "rates": {"USD": 1.1}})


class ValidateAgainstTests(unittest.TestCase):
    PREVIOUS = {"rate_date": "2026-09-30", "rates": {"CNY": {"rate": "6.7"}, "EUR": {"rate": "0.88"}, "USD": {"rate": "1"}}}

    def test_a_normal_move_passes(self):
        fx_sync.validate_against(self.PREVIOUS, "2026-10-01", {"CNY": "6.75", "EUR": "0.89", "USD": "1"})
        fx_sync.validate_against(self.PREVIOUS, "2026-09-30", {"CNY": "6.7", "USD": "1"})  # same day republish is fine
        fx_sync.validate_against(None, "2026-10-01", {"CNY": "1000"})  # nothing to compare to

    def test_a_date_that_goes_backwards_is_refused(self):
        with self.assertRaises(ValueError):
            fx_sync.validate_against(self.PREVIOUS, "2026-09-29", {"CNY": "6.7", "USD": "1"})

    def test_a_large_jump_refuses_the_whole_file_not_just_that_currency(self):
        with self.assertRaises(ValueError) as caught:
            fx_sync.validate_against(self.PREVIOUS, "2026-10-01", {"CNY": "9.5", "EUR": "0.88", "USD": "1"})
        self.assertIn("CNY", str(caught.exception))


class DocumentTests(unittest.TestCase):
    def test_the_document_has_the_shape_the_app_parser_expects(self):
        _, adopted, rejected, _ = fx_sync.merge(*pair())
        doc = fx_sync.build_document("2026-10-01", adopted, rejected, dt.datetime(2026, 10, 1, 3, 0, tzinfo=dt.timezone.utc))
        self.assertEqual((doc["base"], doc["rate_date"], doc["captured_at"]), ("USD", "2026-10-01", "2026-10-01T03:00:00Z"))
        self.assertEqual(doc["rates"]["USD"]["rate"], "1")
        self.assertTrue(all(isinstance(v["rate"], str) for v in doc["rates"].values()), "rates are decimal strings")

    def test_an_unchanged_rate_set_does_not_rewrite_the_file(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "fx-sync.json"
            ecb = Path(temp) / "ecb.json"
            fawaz = Path(temp) / "fawaz.json"
            ecb.write_text(json.dumps({"base": "USD", "date": "2026-10-01", "rates": {"CNY": 6.7}}))
            fawaz.write_text(json.dumps({"date": "2026-10-01", "usd": {"cny": 6.7}}))
            original_out, original_base = fx_sync.OUT, fx_sync.BASELINE
            fx_sync.OUT, fx_sync.BASELINE = out, Path(temp) / "none.json"
            try:
                self.assertEqual(fx_sync.main(["--write", "--ecb-file", str(ecb), "--fawaz-file", str(fawaz)]), 0)
                first = out.read_text()
                self.assertEqual(fx_sync.main(["--write", "--ecb-file", str(ecb), "--fawaz-file", str(fawaz)]), 0)
                self.assertEqual(out.read_text(), first, "captured_at alone must not cause a rewrite")
            finally:
                fx_sync.OUT, fx_sync.BASELINE = original_out, original_base


if __name__ == "__main__":
    unittest.main()
