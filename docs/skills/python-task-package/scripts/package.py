#!/usr/bin/env python3
"""Validate an AutoCodeFlow Python task package and build its deploy zip.

Layout contract enforced here mirrors what the executors consume:
  apps/executor-python/manifest.py       (load_manifest / merge_task_with_manifest)
  apps/executor-python/routers/execute.py (_read_package_requirements, zip channel)
  apps/executor-node/src/routes/execute.ts (readPackageRequirements)

Usage:
    python scripts/package.py <project_dir> [--out <zip_path>] [--dry-run]

Exit codes: 0 ok, 1 validation error, 2 usage/IO error.

Only the standard library is required. PyYAML is used when available for a
strict manifest parse; otherwise a light regex fallback reads top-level keys.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import zipfile
from pathlib import Path

# Junk that must never ship inside a task package.
EXCLUDE_DIRS = {
    "__pycache__", ".venv", "venv", ".git", ".idea", ".vscode",
    "node_modules", "dist", "build", ".pytest_cache", ".mypy_cache",
}
EXCLUDE_SUFFIXES = {".pyc", ".pyo", ".egg-info"}
EXCLUDE_FILES = {".DS_Store"}

RUNTIME_VERSION_RE = re.compile(r"^\d+\.\d+$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def err(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


def _parse_manifest(path: Path, report: Report) -> dict:
    text = path.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore
    except ImportError:
        yaml = None
    if yaml is not None:
        try:
            data = yaml.safe_load(text) or {}
            if not isinstance(data, dict):
                report.err("manifest.yaml must be a YAML mapping at top level")
                return {}
            return data
        except Exception as e:  # noqa: BLE001
            report.err(f"manifest.yaml is not valid YAML: {e}")
            return {}
    # Fallback: scrape simple top-level "key: value" scalars so the script still
    # works without PyYAML. Nested lists (tasks/requirements) are not validated.
    data: dict = {}
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if m and not line.lstrip().startswith("#"):
            key, val = m.group(1), m.group(2).strip().strip('"\'')
            if val:
                data[key] = val
    report.warn("PyYAML absent: used lightweight manifest key scraping")
    return data


def _check_requirements(root: Path, report: Report) -> None:
    # Case-insensitive scan of the top level only (parity with executors).
    req_file = None
    for name in os.listdir(root):
        if name.lower() == "requirements.txt":
            candidate = root / name
            if candidate.is_file():
                req_file = candidate
                break
    if req_file is None:
        return
    for lineno, raw in enumerate(req_file.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("-"):
            report.err(
                f"requirements.txt:{lineno} option-style entry '{line}' is "
                "rejected by the executor (R4-C); only package specs allowed"
            )
        if re.search(r"://", line) or line.lower().startswith("http"):
            report.warn(
                f"requirements.txt:{lineno} looks like a URL; private index is "
                "configured executor-side (PYPI_REGISTRY_URL), not here"
            )


def validate(root: Path, report: Report) -> dict:
    if not root.is_dir():
        report.err(f"not a directory: {root}")
        return {}

    # Anti-pattern: task packages are plain script zips, not pip wheels.
    for bad in ("pyproject.toml", "setup.py"):
        if (root / bad).exists():
            report.warn(
                f"{bad} found at root: this is a task-script package, not a pip "
                "package; harmless to the zip but usually a mistake"
            )

    manifest_path = None
    for cand in ("manifest.yaml", "manifest.yml"):
        if (root / cand).is_file():
            manifest_path = root / cand
            break
    if manifest_path is None:
        report.err("missing manifest.yaml (or manifest.yml) at package root")
        return {}

    manifest = _parse_manifest(manifest_path, report)

    name = str(manifest.get("name", "")).strip()
    version = str(manifest.get("version", "")).strip()
    runtime = str(manifest.get("runtime", "python")).strip().lower()

    if name and not NAME_RE.match(name):
        report.err(f"manifest.name '{name}' has unsupported chars")
    # name/version live on the application record, not necessarily the manifest.
    # Fall back to an optional VERSION file for the build artifact name.
    if not version and (root / "VERSION").is_file():
        version = (root / "VERSION").read_text(encoding="utf-8").strip()
    if runtime not in ("python", "node"):
        report.err(f"manifest.runtime '{runtime}' must be python or node")

    if (rv := manifest.get("runtimeVersion")):
        # 注意：runtimeVersion 是**任务**上的字段，执行器从任务载荷读取
        # （apps/executor-python/routers/execute.py 的 task.get('runtimeVersion')），
        # manifest.yaml 里的同名键**不会被消费**。这里只做形态提示，不阻断打包。
        if not RUNTIME_VERSION_RE.match(str(rv)):
            report.warn(
                f"manifest.runtimeVersion '{rv}' is not Major.Minor (e.g. 3.12)"
            )
        report.warn(
            "manifest.yaml carries runtimeVersion: the executor reads the Python "
            "version from the TASK field (runtimeVersion on POST /api/tasks), not "
            "from the package manifest — this key has no effect"
        )

    # Resolve the entry script(s) that must exist inside the zip.
    entry = str(manifest.get("entrypoint", "main.py")).strip() or "main.py"
    if not (root / entry).is_file():
        report.err(f"entrypoint '{entry}' not found under package root")

    tasks = manifest.get("tasks")
    if isinstance(tasks, list) and tasks:
        # The zip runtime path (executor manifest.py) ignores tasks[]; multi-task
        # auto-registration only reads tasks[] from a git repo's manifest.json.
        report.warn(
            "manifest.yaml carries tasks[]: the zip runtime path ignores it "
            "(only git-deploy manifest.json auto-registers tasks); single-entry "
            "packages should rely on entrypoint"
        )
        for i, t in enumerate(tasks):
            tentry = str(t.get("entrypoint") or t.get("entry") or "").strip() if isinstance(t, dict) else ""
            if tentry and not (root / tentry).is_file():
                report.err(f"tasks[{i}] entry '{tentry}' not found under root")

    _check_requirements(root, report)
    return {"name": name or root.name, "version": version or "0.0.0"}


def _iter_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d for d in dirnames
            if d not in EXCLUDE_DIRS and not d.endswith(".egg-info")
        ]
        for fn in filenames:
            if fn in EXCLUDE_FILES:
                continue
            if any(fn.endswith(s) for s in EXCLUDE_SUFFIXES):
                continue
            full = Path(dirpath) / fn
            if full.is_symlink():  # never follow symlinks into the zip
                continue
            if fn.endswith(".zip"):  # don't re-package prior build outputs
                continue
            yield full


def build_zip(root: Path, out_path: Path) -> list[str]:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    added: list[str] = []
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for full in sorted(_iter_files(root)):
            arc = full.relative_to(root).as_posix()  # forward slashes, root-relative
            zf.write(full, arcname=arc)
            added.append(arc)
    return added


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("project_dir", help="directory containing manifest.yaml")
    parser.add_argument("--out", help="output zip path (default: <parent>/<name>-<version>.zip)")
    parser.add_argument("--dry-run", action="store_true", help="validate only, do not write a zip")
    args = parser.parse_args(argv)

    root = Path(args.project_dir).resolve()
    report = Report()
    meta = validate(root, report)

    for w in report.warnings:
        print(f"WARN  {w}", file=sys.stderr)
    for e in report.errors:
        print(f"ERROR {e}", file=sys.stderr)

    if report.errors:
        print(f"\nValidation FAILED: {len(report.errors)} error(s), {len(report.warnings)} warning(s).", file=sys.stderr)
        return 1

    if args.dry_run:
        print(f"OK (dry-run): structure valid ({len(report.warnings)} warning(s)).")
        return 0

    if args.out:
        out_path = Path(args.out).resolve()
    else:
        out_path = root.parent / f"{meta.get('name', root.name)}-{meta.get('version', '0.0.0')}.zip"

    added = build_zip(root, out_path)
    print(f"Built {out_path}")
    print("  zip root contains:")
    for a in added:
        print(f"    {a}")
    if report.warnings:
        print(f"({len(report.warnings)} warning(s) above did not block packaging.)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
