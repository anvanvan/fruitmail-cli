"""RED guard tests (behaviors 23, 24): the indexer sources must exist, use only
the CocoIndex v1 API, declare cocoindex as the sole runtime dependency, import
no networking modules, and stay a bare module directory (no __init__.py, F1).
"""

from __future__ import annotations

import pathlib
import re

INDEXER_DIR = pathlib.Path(__file__).resolve().parent.parent
EXPECTED_SOURCES = ["main.py", "emlx.py", "paths.py", "schema.py"]

V0_IDENTIFIERS = [
    "flow_def",
    "FlowBuilder",
    "DataScope",
    "DataSlice",
    "add_source",
    "KTable",
    "cocoindex.init",
]

NETWORK_IMPORT_RE = re.compile(
    r"^\s*(?:import|from)\s+(socket|urllib|requests|aiohttp|httpx|http)\b",
    re.MULTILINE,
)


def _sources() -> list[pathlib.Path]:
    return [INDEXER_DIR / name for name in EXPECTED_SOURCES]


def test_indexer_source_modules_exist():
    missing = [path.name for path in _sources() if not path.exists()]
    assert missing == [], f"missing indexer modules: {missing}"


def test_no_v0_api_identifiers_in_indexer_sources():
    offenders: list[str] = []
    for path in _sources():
        assert path.exists(), f"{path.name} does not exist yet"
        text = path.read_text()
        for ident in V0_IDENTIFIERS:
            if ident in text:
                offenders.append(f"{path.name}: {ident}")
    assert offenders == []


def test_no_network_module_imports_in_indexer_sources():
    offenders: list[str] = []
    for path in _sources():
        assert path.exists(), f"{path.name} does not exist yet"
        for match in NETWORK_IMPORT_RE.finditer(path.read_text()):
            offenders.append(f"{path.name}: {match.group(0).strip()}")
    assert offenders == []


def test_pyproject_declares_cocoindex_as_only_runtime_dependency():
    import tomllib

    pyproject_path = INDEXER_DIR / "pyproject.toml"
    assert pyproject_path.exists(), "indexer/pyproject.toml does not exist yet"
    data = tomllib.loads(pyproject_path.read_text())
    deps = data["project"]["dependencies"]
    assert len(deps) == 1
    assert deps[0].startswith("cocoindex")


def test_committed_uv_lock_exists():
    assert (INDEXER_DIR / "uv.lock").exists(), "indexer/uv.lock (committed lockfile) missing"
