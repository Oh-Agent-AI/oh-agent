"""归因签名目录的纯规则层——Rust `agent_vitals_domain::attribution` 的镜像。

只回答两个执行环境无关的问题：这个模型是谁家的（L0 `model_vendor`）、这条记录像是
打到了谁的端点（L1 `route_shape`）。不回答「谁收的钱」。厂商知识全部来自
`assets/attribution_signatures.json`（与 Rust `include_str!` 同一份文件），
两边逐字节同判由 `tests/test_attribution_signatures.py` 与 claude emitter 的
差分测试钉住。
"""

import json
import re
from pathlib import Path
from typing import NamedTuple, Optional

_SIGNATURES_PATH = Path(__file__).resolve().parents[4] / "assets" / "attribution_signatures.json"
_CATALOG = None


def signatures() -> dict:
    global _CATALOG
    if _CATALOG is None:
        with open(_SIGNATURES_PATH, encoding="utf-8") as fh:
            _CATALOG = json.load(fh)
    return _CATALOG


class VendorMatch(NamedTuple):
    vendor: str
    gateway_named: bool


def _is_sentinel(catalog: dict, model: str) -> bool:
    return model in (catalog.get("sentinels", {}).get("models") or [])


def _vendor_by_prefix(catalog: dict, model: str) -> Optional[str]:
    lower = model.lower()
    best = None  # (len, vendor)
    for vendor, spec in (catalog.get("vendors") or {}).items():
        for prefix in spec.get("model_prefixes") or []:
            p = str(prefix).lower()
            if p and lower.startswith(p) and (best is None or len(p) > best[0]):
                best = (len(p), vendor)
    return best[1] if best else None


def model_vendor(model: str, catalog: Optional[dict] = None) -> Optional[VendorMatch]:
    catalog = catalog or signatures()
    model = (model or "").strip()
    if not model or _is_sentinel(catalog, model):
        return None
    separator = (catalog.get("gateway_naming") or {}).get("separator") or "/"
    if separator in model:
        prefix, rest = model.split(separator, 1)
        if rest:
            alias = ((catalog.get("gateway_naming") or {}).get("aliases") or {}).get(prefix.lower())
            if alias:
                return VendorMatch(alias, True)
            # 两级网关名（openrouter/anthropic/claude-…）：剥一层继续判，网关身份保留。
            inner = model_vendor(rest, catalog)
            return VendorMatch(inner.vendor, True) if inner else None
    vendor = _vendor_by_prefix(catalog, model)
    return VendorMatch(vendor, False) if vendor else None


# RouteShape 词表（与 Rust 枚举同构，用 (kind, vendor) 元组表示）
OFFICIAL_VENDOR = "official_vendor"
VENDOR_SHAPE = "vendor_shape"
GATEWAY = "gateway"
UNKNOWN = "unknown"

_EVIDENCE_BASIS = {OFFICIAL_VENDOR: "session-native", VENDOR_SHAPE: "inferred",
                   GATEWAY: "inferred", UNKNOWN: "missing"}


def evidence_basis_of(kind: str) -> str:
    return _EVIDENCE_BASIS[kind]


def _matches(pattern: Optional[str], value: Optional[str]) -> bool:
    # 含空白/控制字符的 ID 一律不命中（镜像 Rust `matches`）：`$` 在 Python 是串尾
    # 或末尾换行前，Rust 是串尾，不加这道闸两边会分叉。
    if not pattern or not value or any(ch.isspace() or ord(ch) < 32 or ord(ch) == 127 for ch in value):
        return False
    try:
        return re.search(pattern, value) is not None
    except re.error:
        return False


def route_shape(model: str, request_id: Optional[str], message_id: Optional[str],
                catalog: Optional[dict] = None):
    """→ (kind, vendor_or_None)。镜像 Rust `route_shape`。"""
    catalog = catalog or signatures()
    match = model_vendor(model, catalog)
    if match is None:
        return (UNKNOWN, None)
    if match.gateway_named:
        return (GATEWAY, None)
    spec = (catalog.get("vendors") or {}).get(match.vendor) or {}
    request_pattern = spec.get("request_id_pattern")
    message_pattern = spec.get("message_id_pattern")
    message_hit = _matches(message_pattern, message_id)
    if request_pattern:
        request_hit = _matches(request_pattern, request_id)
        if request_hit and message_hit:
            return (OFFICIAL_VENDOR, match.vendor)
        return (GATEWAY, None) if message_id is not None else (UNKNOWN, None)
    if message_id is None:
        return (UNKNOWN, None)
    return (VENDOR_SHAPE, match.vendor) if message_hit else (GATEWAY, None)


def official_endpoint_of(vendor: str, catalog: Optional[dict] = None) -> Optional[str]:
    catalog = catalog or signatures()
    endpoints = ((catalog.get("vendors") or {}).get(vendor) or {}).get("official_endpoints") or []
    return endpoints[0] if endpoints else None
