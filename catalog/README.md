# Official catalog

`pricing/` owns `pricing.json`, `codex_pricing.json` and `pricing-sync.json`.
The corresponding files in `assets/` are byte-identical compatibility mirrors:
old public URLs, compiled price tables and distributed Python packages retain
their existing paths and schemas. Prices are unchanged by this migration.

Edit the authoritative files, then run `python3 scripts/catalog_mirror.py --write`.
`python3 scripts/catalog_mirror.py` checks drift without writing. Daily price
sync updates the authoritative overlay and its mirror in the same CI commit.
FX sync retains its existing path. Provider-by-provider splitting is deferred
until its slot handler and schema are implemented.

Harness payloads use `harnesses/<slug>.json`. The index records a full Git commit SHA
and SHA-256 of the raw bytes at that commit. Commit the payload first; a later
index change can reference that actual commit. A payload and the index that
references its introducing commit cannot be introduced in one self-referencing
commit. Uncommitted bytes cannot substitute for the pinned Git blob.

Run `python3 scripts/verify_catalog.py` before publishing. This offline gate
validates the index, dependency closure and each pinned harness blob's size, hash,
schema, identity and capability declarations. CI needs full Git history to
resolve referenced commits. Currently the index is empty: a passing check does
not claim any real host payload is published.

Catalog checks do not grant runtime origin to local files. The installed app
acquires vendor origin only through its fixed official download channel and
explicit preview/confirmation. Local copies use the local import path.
