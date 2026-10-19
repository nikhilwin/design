#!/usr/bin/env python3
# ruff: noqa: E501  (the messages and the generated Markdown are prose; wrapping them would only hurt)
"""Licence audit of the repository: dependency inventory and consistency checks.

    python licenses/audit.py            # print the inventory (Markdown) to the terminal
    python licenses/audit.py --write    # rewrite licenses/DEPENDENCIES.md and licenses/bundled-licenses.txt
    python licenses/audit.py --check    # exit 1 when a licence is unknown or not permissive and has no
                                        # recorded decision, when the committed inventory is out of date, or
                                        # when THIRD_PARTY.md and the data manifests disagree

Run it with the backend's virtual environment (it reads the installed Python packages' metadata and needs
`packaging`) after `npm ci` in frontend/ (it reads the installed npm packages' package.json and licence files):

    backend/.venv/bin/python licenses/audit.py --check

Where the facts come from (nothing is taken from memory):
  * npm: `frontend/package-lock.json` and `backend/apps/collab/tests/interop/package-lock.json` for the package list,
    the installed `node_modules/<pkg>/package.json` for the licence expression and the LICENSE/NOTICE files next to it.
    Which packages reach the browser is measured: a production `vite build --sourcemap` is made in a temporary
    folder and the source maps are read (`--no-build` skips it and treats every non-dev package as shipped).
  * Python: `importlib.metadata` of the running interpreter. The closure of `backend/requirements.txt` is the
    server runtime, the rest of the closure of `backend/requirements-dev.txt` is development and test only.
    Metadata that is not an SPDX expression is replaced by what the package's LICENSE file says.
  * Decisions about anything that is not plain permissive, and the few corrections of wrong metadata, live in
    `licenses/exceptions.json`, each with the reason.

Standard library only, apart from `packaging` for requirement markers.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
FRONTEND = ROOT / "frontend"
INTEROP = ROOT / "backend" / "apps" / "collab" / "tests" / "interop"
BACKEND = ROOT / "backend"
EXCEPTIONS = HERE / "exceptions.json"
INVENTORY = HERE / "DEPENDENCIES.md"
BUNDLED = HERE / "bundled-licenses.txt"
THIRD_PARTY = ROOT / "THIRD_PARTY.md"

#: SPDX identifiers that need no decision. The first block is the product owner's list; the second block is
#: licences of the same kind (permissive, no copyleft, no field-of-use limit) that occur in dependencies.
PERMISSIVE = frozenset(
    {
        "MIT",
        "ISC",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "Apache-2.0",
        "0BSD",
        "CC0-1.0",
        "OFL-1.1",
        "Unlicense",
        "Python-2.0",
        "PSF-2.0",
        "MIT-0",
        "Zlib",
        "BlueOak-1.0.0",
        "MIT-CMU",
        "ZPL-2.1",
        "TCL",
        "WTFPL",
    }
)
#: Licence families that must never be hidden behind a permissive-looking metadata field.
COPYLEFT_MARKERS = {
    "AGPL": "AGPL",
    "LGPL": "LGPL",
    "GPL": "GPL",
    "MPL-2.0": "MPL-2.0",
    "CC-BY": "CC-BY",
    "CC-BY-SA": "CC-BY-SA",
    "CC-BY-NC": "CC-BY-NC",
    "EUPL": "EUPL",
    "SSPL": "SSPL",
}
#: Preference when an OR expression offers several permissive alternatives.
ELECTION_ORDER = ("MIT", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "ISC", "CC0-1.0", "0BSD")
LICENCE_FILE = re.compile(
    r"^(licen[sc]e|licen[sc]es|copying|notice|unlicen[sc]e|copyright|authors)([-._].*)?$", re.I
)
PLATFORM_SUFFIX = re.compile(
    r"-(aix|android|darwin|freebsd|linux|netbsd|openbsd|openharmony|sunos|win32|wasm32)(-.*)?$"
)


# --------------------------------------------------------------------------------------------- SPDX handling


def tokens(expression: str) -> list[str]:
    cleaned = re.sub(r"SEE LICENSE IN (\S+)", r"LicenseRef-see-\1", expression.strip())
    return re.findall(r"\(|\)|[^\s()]+(?:\s+WITH\s+[^\s()]+)?", cleaned)


def parse(expression: str):
    """Tiny SPDX expression parser: ('or'|'and', left, right) or a leaf string. AND binds tighter than OR."""
    toks = tokens(expression)
    pos = 0

    def peek() -> str | None:
        return toks[pos] if pos < len(toks) else None

    def take() -> str:
        nonlocal pos
        pos += 1
        return toks[pos - 1]

    def atom():
        tok = take()
        if tok == "(":
            node = disjunction()
            if peek() == ")":
                take()
            return node
        return tok

    def conjunction():
        node = atom()
        while peek() == "AND":
            take()
            node = ("and", node, atom())
        return node

    def disjunction():
        node = conjunction()
        while peek() == "OR":
            take()
            node = ("or", node, conjunction())
        return node

    return disjunction()


def is_permissive(node) -> bool:
    if isinstance(node, tuple):
        op, left, right = node
        return (
            (is_permissive(left) or is_permissive(right))
            if op == "or"
            else (is_permissive(left) and is_permissive(right))
        )
    return node in PERMISSIVE or node.removesuffix("+") in PERMISSIVE


def atoms(node) -> list[str]:
    return atoms(node[1]) + atoms(node[2]) if isinstance(node, tuple) else [node]


def election(node) -> str | None:
    """The permissive alternative used when an OR offers a non-permissive one too, else None."""
    if not isinstance(node, tuple):
        return None
    op, left, right = node
    if op == "and":
        parts = [election(left) or flat(left), election(right) or flat(right)]
        return " AND ".join(parts) if (election(left) or election(right)) else None
    options = [(election(side) or flat(side), side) for side in (left, right)]
    good = [text for text, side in options if is_permissive(side)]
    if len(good) == len(options) and not any(election(side) for _, side in options):
        return None
    for preferred in ELECTION_ORDER:
        for text in good:
            if preferred in text:
                return text
    return good[0] if good else None


def flat(node) -> str:
    if isinstance(node, tuple):
        op, left, right = node
        return f"({flat(left)} {op.upper()} {flat(right)})"
    return node


def classify_text(text: str) -> set[str]:
    """Licence families a LICENSE file's text identifies (permissive ones loosely, copyleft ones strictly)."""
    t = " ".join(text.lower().split())
    found: set[str] = set()
    if "apache license" in t and "version 2.0" in t:
        found.add("Apache-2.0")
    if "gnu affero general public license" in t:
        found.add("AGPL")
    if "gnu lesser general public license" in t or "gnu library general public license" in t:
        found.add("LGPL")
    if (
        re.search(r"gnu general public license(?! *\()", t)
        and "lesser" not in t.split("gnu general public license")[0][-40:]
    ):
        found.add("GPL")
    if "mozilla public license" in t:
        found.add("MPL-2.0")
    if "creative commons" in t and re.search(r"attribution(-sharealike)? 4\.0|cc by", t):
        found.add("CC-BY-SA" if "sharealike" in t else "CC-BY")
    if "mozilla public license" in t:
        found -= {"AGPL", "LGPL", "GPL"}  # the MPL text names them as possible "Secondary Licenses"
    if "permission is hereby granted, free of charge" in t:
        found.add("MIT")
    if (
        "permission to use, copy, modify, and/or distribute this software for any purpose with or without fee"
        in t
    ):
        found.add("ISC")
    if "redistribution and use in source and binary forms" in t:
        if "all advertising materials" in t:
            found.add("BSD-4-Clause")
        elif re.search(
            r"neither the name|(names?|name of)[^.]*(may|must|shall) (not )?be used to endorse or promote", t
        ):
            found.add("BSD-3-Clause")
        else:
            found.add("BSD-2-Clause")
    if "this is free and unencumbered software released into the public domain" in t:
        found.add("Unlicense")
    if "cc0 1.0" in t or "cc0-1.0" in t:
        found.add("CC0-1.0")
    if "sil open font license" in t:
        found.add("OFL-1.1")
    if "python software foundation license" in t:
        found.add("PSF-2.0")
    if "ubuntu font licence" in t:
        found.add("UFL-1.0")
    return found


# --------------------------------------------------------------------------------------------- data model


@dataclass
class Pkg:
    eco: str  # "npm" or "pip"
    name: str
    version: str
    declared: str = ""  # range from package.json / requirements*.txt (direct dependencies only)
    licence: str = ""  # SPDX expression
    origin: str = ""  # where the expression comes from
    scope: str = ""  # browser | build/test (npm); server | dev/test (pip)
    url: str = ""
    files: list[str] = field(default_factory=list)
    texts: dict[str, str] = field(default_factory=dict)
    flags: list[str] = field(default_factory=list)
    direct: bool = False

    @property
    def key(self) -> str:
        return f"{self.eco}:{norm(self.name) if self.eco == 'pip' else self.name}"


def load_exceptions() -> dict:
    return json.loads(EXCEPTIONS.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------------------------- npm


def package_name_from_path(path: str) -> str:
    return path.rsplit("node_modules/", 1)[-1]


def read_licence_files(directory: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not directory.is_dir():
        return out
    for entry in sorted(directory.iterdir()):
        if entry.is_file() and LICENCE_FILE.match(
            entry.stem if entry.suffix in {".md", ".txt", ".markdown"} else entry.name
        ):
            if entry.name.upper().startswith("AUTHORS"):
                continue
            out[entry.name] = entry.read_text(encoding="utf-8", errors="replace")
    return out


def repo_url(meta: dict, name: str) -> str:
    repo = meta.get("repository")
    url = repo.get("url") if isinstance(repo, dict) else repo
    if isinstance(url, str) and url:
        url = re.sub(r"^git\+", "", url)
        url = re.sub(r"^(git://|ssh://git@|git@)", "https://", url)
        url = url.replace("https://github.com:", "https://github.com/").removesuffix(".git")
        if url.startswith("github:"):
            url = "https://github.com/" + url[7:]
        if re.fullmatch(r"[\w.-]+/[\w.-]+", url):
            url = "https://github.com/" + url
        if url.startswith("https://"):
            return url
    home = meta.get("homepage")
    if isinstance(home, str) and home.startswith("http"):
        return home.split("#")[0]
    return f"https://www.npmjs.com/package/{name}"


def npm_licence(meta: dict) -> str:
    lic = meta.get("license")
    if isinstance(lic, dict):
        lic = lic.get("type")
    if not lic and isinstance(meta.get("licenses"), list):
        lic = " OR ".join(x.get("type", "") for x in meta["licenses"])
    return lic or ""


def load_npm(base: Path, scope_for_dev: str, extra_direct: dict[str, str] | None = None) -> list[Pkg]:
    lock = json.loads((base / "package-lock.json").read_text(encoding="utf-8"))
    manifest = json.loads((base / "package.json").read_text(encoding="utf-8"))
    runtime = manifest.get("dependencies", {})
    dev = manifest.get("devDependencies", {})
    out = []
    for path, entry in lock["packages"].items():
        if not path:
            continue
        name = package_name_from_path(path)
        directory = base / path
        installed = directory / "package.json"
        meta = json.loads(installed.read_text(encoding="utf-8")) if installed.is_file() else {}
        locked_licence = entry.get("license", "")
        pkg = Pkg("npm", name, entry.get("version", meta.get("version", "")))
        pkg.licence = npm_licence(meta) or locked_licence
        pkg.origin = "package.json" if meta else "package-lock.json (not installed on this platform)"
        if meta and locked_licence and npm_licence(meta) != locked_licence:
            pkg.flags.append(
                f"lockfile says {locked_licence}, installed package.json says {npm_licence(meta)}"
            )
        pkg.url = repo_url(meta, name) if meta else f"https://www.npmjs.com/package/{name}"
        pkg.texts = read_licence_files(directory)
        pkg.files = sorted(pkg.texts)
        pkg.direct = path == f"node_modules/{name}" and (name in runtime or name in dev)
        pkg.declared = runtime.get(name, dev.get(name, "")) if path == f"node_modules/{name}" else ""
        pkg.scope = "build/test" if entry.get("dev") else "runtime"  # refined by `mark_bundle`
        out.append(pkg)
    return out


def bundled_names(skip_build: bool) -> set[str] | None:
    """Names of the npm packages whose code is in a production build (read from its source maps)."""
    if skip_build:
        return None
    out_dir = Path(tempfile.mkdtemp(prefix="doory-licence-build-"))
    try:
        command = [
            "npx",
            "--no-install",
            "vite",
            "build",
            "--sourcemap",
            "--outDir",
            str(out_dir),
            "--emptyOutDir",
        ]
        result = subprocess.run(command, cwd=FRONTEND, capture_output=True, text=True, check=False)  # noqa: S603
        if result.returncode != 0:
            sys.exit(f"vite build failed:\n{result.stdout[-1500:]}\n{result.stderr[-1500:]}")
        names: set[str] = set()
        for map_file in (out_dir / "assets").glob("*.map"):
            for source in json.loads(map_file.read_text(encoding="utf-8")).get("sources", []):
                if "node_modules/" in source:
                    parts = source.rsplit("node_modules/", 1)[1].split("/")
                    names.add("/".join(parts[:2]) if parts[0].startswith("@") else parts[0])
        return names
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


def mark_bundle(packages: list[Pkg], bundled: set[str] | None, prebundled: dict[str, list[str]]) -> None:
    shipped = set(bundled or ())
    for host, inner in prebundled.items():
        if host in shipped or bundled is None:
            shipped.update(inner)
    for pkg in packages:
        if pkg.scope == "build/test":
            continue
        if (
            bundled is None
            or pkg.name in shipped
            or (pkg.direct and pkg.declared and pkg.name in direct_runtime_names())
        ):
            pkg.scope = "browser"
        else:
            pkg.scope = "build/test"
            pkg.flags.append("in the runtime closure of package-lock.json but not in the production bundle")


def direct_runtime_names() -> set[str]:
    return set(json.loads((FRONTEND / "package.json").read_text(encoding="utf-8")).get("dependencies", {}))


# --------------------------------------------------------------------------------------------- Python


def norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def read_requirements(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        match = re.match(r"([A-Za-z0-9_.-]+)(\[[^\]]*\])?\s*(.*)$", line)
        if match:
            out[norm(match.group(1))] = match.group(3).strip()
    return out


def closure(roots: list[str], dists: dict[str, metadata.Distribution]) -> set[str]:
    from packaging.requirements import Requirement

    seen: set[str] = set()
    queue: list[tuple[str, frozenset[str]]] = [(norm(r), frozenset()) for r in roots]
    visited: set[tuple[str, frozenset[str]]] = set()
    while queue:
        name, extras = queue.pop()
        if (name, extras) in visited or name not in dists:
            continue
        visited.add((name, extras))
        seen.add(name)
        for raw in dists[name].requires or []:
            req = Requirement(raw)
            wanted = ["", *sorted(extras)]
            if req.marker is None or any(req.marker.evaluate({"extra": extra}) for extra in wanted):
                queue.append((norm(req.name), frozenset(req.extras)))
    return seen


PIP_LEGACY = {
    "mit": "MIT",
    "mit license": "MIT",
    "bsd": "",
    "bsd license": "",
    "apache 2.0": "Apache-2.0",
    "apache-2.0": "Apache-2.0",
    "apache license 2.0": "Apache-2.0",
    "apache license, version 2.0": "Apache-2.0",
    "apache software license": "Apache-2.0",
    "psfl": "PSF-2.0",
    "bsd-3-clause": "BSD-3-Clause",
    "bsd-2-clause": "BSD-2-Clause",
    "bsd 3-clause or apache-2.0": "BSD-3-Clause OR Apache-2.0",
}


def pip_licence(dist: metadata.Distribution, texts: dict[str, str], overrides: dict) -> tuple[str, str]:
    meta = dist.metadata
    key = f"pip:{norm(meta['Name'])}"
    if key in overrides:
        return overrides[key][
            "licence"
        ], "licenses/exceptions.json (corrected after reading the LICENSE file)"
    expression = meta.get("License-Expression")
    if expression:
        return expression, "License-Expression"
    from_files = set()
    for text in texts.values():
        from_files |= classify_text(text)
    legacy = (meta.get("License") or "").strip()
    mapped = PIP_LEGACY.get(legacy.lower())
    if mapped:
        return mapped, "License field"
    permissive_found = sorted(f for f in from_files if f in PERMISSIVE)
    if len(permissive_found) == 1 and not (from_files - set(permissive_found)):
        return permissive_found[0], "LICENSE file (metadata is not an SPDX expression)"
    classifiers = [
        c.split("::")[-1].strip() for c in meta.get_all("Classifier") or [] if c.startswith("License ::")
    ]
    return " / ".join(classifiers) or legacy[:60] or "UNKNOWN", "classifier or free text: needs an override"


def pip_url(meta) -> str:
    for label in ("Source", "Repository", "Source Code", "Homepage", "Home"):
        for entry in meta.get_all("Project-URL") or []:
            key, _, value = entry.partition(",")
            if key.strip().lower() == label.lower() and value.strip().startswith("http"):
                return value.strip().removesuffix(".git")
    home = meta.get("Home-page")
    if home and home.startswith("http"):
        return home.removesuffix(".git")
    return f"https://pypi.org/project/{meta['Name']}/"


def load_pip(overrides: dict) -> list[Pkg]:
    dists = {norm(d.metadata["Name"]): d for d in metadata.distributions()}
    runtime_reqs = read_requirements(BACKEND / "requirements.txt")
    dev_reqs = read_requirements(BACKEND / "requirements-dev.txt")
    runtime = closure(list(runtime_reqs), dists)
    development = closure(list(dev_reqs), dists) - runtime
    out = []
    for name in sorted(runtime | development):
        dist = dists[name]
        texts: dict[str, str] = {}
        for rel in dist.files or []:
            stem = rel.name.rsplit(".", 1)[0] if "." in rel.name else rel.name
            if (
                "dist-info" in str(rel)
                and LICENCE_FILE.match(stem)
                and not rel.name.upper().startswith("AUTHORS")
            ):
                texts[rel.name] = Path(str(dist.locate_file(rel))).read_text(
                    encoding="utf-8", errors="replace"
                )
        pkg = Pkg("pip", dist.metadata["Name"], dist.version, texts=texts, files=sorted(texts))
        pkg.licence, pkg.origin = pip_licence(dist, texts, overrides)
        pkg.url = pip_url(dist.metadata)
        pkg.scope = "server" if name in runtime else "dev/test"
        pkg.direct = name in runtime_reqs or name in dev_reqs
        pkg.declared = runtime_reqs.get(name) or dev_reqs.get(name) or ""
        out.append(pkg)
    return out


# --------------------------------------------------------------------------------------------- analysis


def review(packages: list[Pkg], decisions: dict, text_reviewed: dict) -> list[str]:
    """Problems that fail --check: unknown or non-permissive licences without a recorded decision, text/metadata clashes."""
    problems = []
    for pkg in packages:
        if not pkg.licence or pkg.licence == "UNKNOWN":
            problems.append(f"{pkg.key}@{pkg.version}: no licence information")
            continue
        node = parse(pkg.licence)
        decided = pkg.key in decisions
        if not is_permissive(node) and not decided:
            problems.append(
                f"{pkg.key}@{pkg.version}: {pkg.licence} is not permissive and has no decision in exceptions.json"
            )
        if not pkg.texts and not decided and pkg.eco == "pip":
            problems.append(f"{pkg.key}@{pkg.version}: no licence file in the distribution")
        declared_atoms = {a.removesuffix("+").split(" WITH ")[0] for a in atoms(node)}
        for text_name, text in pkg.texts.items():
            risky = {f for f in classify_text(text) if f in COPYLEFT_MARKERS and f not in declared_atoms}
            risky = {f for f in risky if not any(a.startswith(f) for a in declared_atoms)}
            if risky and not decided and pkg.key not in text_reviewed:
                problems.append(
                    f"{pkg.key}@{pkg.version}: {text_name} mentions {sorted(risky)} but the metadata says {pkg.licence}"
                )
    return problems


def group_platform_builds(packages: list[Pkg]) -> list[Pkg]:
    """Collapse the per-platform binary packages (esbuild, rollup, ...) into one row per family."""
    families: dict[tuple[str, str, str], list[Pkg]] = defaultdict(list)
    keep = []
    for pkg in packages:
        if pkg.eco == "npm" and "not installed on this platform" in pkg.origin:
            families[(PLATFORM_SUFFIX.sub("", pkg.name), pkg.licence, pkg.scope)].append(pkg)
        else:
            keep.append(pkg)
    for (family, licence, scope), members in families.items():
        first = members[0]
        merged = Pkg(
            "npm",
            f"{family}-*",
            first.version,
            licence=licence,
            origin=first.origin,
            scope=scope,
            url=first.url,
        )
        merged.flags.append(f"{len(members)} platform builds")
        keep.append(merged)
    return keep


def signature(packages: list[Pkg]) -> str:
    rows = sorted({(p.eco, p.name, p.licence, p.scope) for p in packages})
    return hashlib.sha256(json.dumps(rows).encode()).hexdigest()[:16]


SCOPE_NAMES = {
    ("npm", "browser"): "npm, shipped to browsers",
    ("npm", "build/test"): "npm, build/test only",
    ("pip", "server"): "Python, server runtime",
    ("pip", "dev/test"): "Python, dev/test only",
}


def render_inventory(packages: list[Pkg], decisions: dict, notes: dict) -> str:
    rows = group_platform_builds(packages)
    lines = [
        "# Dependency inventory",
        "",
        "<!-- Generated by licenses/audit.py --write. Do not edit by hand: change the dependency, then re-run it. -->",
        "",
        "Every direct and transitive npm and Python dependency with the licence its own metadata declares, read from the",
        "installed packages (see the header of `licenses/audit.py` for the sources). The curated view with the decisions",
        "is [THIRD_PARTY.md](../THIRD_PARTY.md); reproduce this file with `python licenses/audit.py --write`.",
        "",
        f"<!-- signature: {signature(rows)} -->",
        "",
        "## Summary",
        "",
        "| Ecosystem and scope | Packages | Licences |",
        "|---|---:|---|",
    ]
    groups: dict[tuple[str, str], list[Pkg]] = defaultdict(list)
    for pkg in rows:
        groups[(pkg.eco, pkg.scope)].append(pkg)
    titles = {
        ("npm", "browser"): "npm packages shipped to browsers (production bundle, fonts, WebAssembly)",
        ("npm", "build/test"): "npm packages for building, testing and development (never shipped)",
        ("pip", "server"): "Python packages of the server runtime (`requirements.txt`)",
        ("pip", "dev/test"): "Python packages for development and tests only (`requirements-dev.txt`)",
    }
    for key in titles:
        members = groups.get(key, [])
        counts = Counter(p.licence for p in members)
        spread = ", ".join(f"{lic} {n}" for lic, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))
        lines.append(f"| {titles[key]} | {len(members)} | {spread} |")
    flagged = [p for p in rows if p.key in decisions]
    lines += [
        "",
        "## Items that are not plain permissive",
        "",
        "| Package | Licence | Scope | Decision |",
        "|---|---|---|---|",
    ]
    for pkg in sorted(flagged, key=lambda p: p.key):
        lines.append(
            f"| `{pkg.name}` {pkg.version} | {pkg.licence} | {SCOPE_NAMES[(pkg.eco, pkg.scope)]} | {decisions[pkg.key]['decision']}: {decisions[pkg.key]['reason']} |"
        )
    elected = [p for p in rows if election(parse(p.licence)) and p.key not in decisions]
    if elected:
        lines += ["", "Packages offering a choice of licences where Doory uses the permissive one:", ""]
        for pkg in sorted(elected, key=lambda p: p.key):
            lines.append(
                f"- `{pkg.name}` {pkg.version}: {pkg.licence}, used under {election(parse(pkg.licence))}"
            )
    for key, title in titles.items():
        members = sorted(groups.get(key, []), key=lambda p: p.name.lower())
        lines += [
            "",
            f"## {title}",
            "",
            "| Package | Version | Declared range | Licence (SPDX) | Source |",
            "|---|---|---|---|---|",
        ]
        for pkg in members:
            extra = f" ({'; '.join(pkg.flags)})" if pkg.flags and "platform builds" in pkg.flags[0] else ""
            lines.append(
                f"| `{pkg.name}`{extra} | {pkg.version} | {f'`{pkg.declared}`' if pkg.declared else ''} | {pkg.licence} | {pkg.url} |"
            )
    lines += ["", f"_{notes['environment']}_", ""]
    return "\n".join(lines)


DIRECT_BEGIN, DIRECT_END = (
    "<!-- BEGIN direct-dependencies (generated by licenses/audit.py --write) -->",
    "<!-- END direct-dependencies -->",
)


def render_direct(packages: list[Pkg], purposes: dict) -> str:
    """The direct dependencies, one table per scope: this is the part of THIRD_PARTY.md that is generated."""
    sections = [
        ("Browser: npm runtime dependencies (`frontend/package.json` `dependencies`)", ("npm", "browser")),
        ("Server: Python runtime dependencies (`backend/requirements.txt`)", ("pip", "server")),
        (
            "Development and tests only: npm (`frontend/package.json` `devDependencies`, and `axe-core`, which `@axe-core/playwright` brings)",
            ("npm", "build/test"),
        ),
        ("Development and tests only: Python (`backend/requirements-dev.txt`)", ("pip", "dev/test")),
    ]
    out: list[str] = []
    for title, key in sections:
        rows = sorted(
            (p for p in packages if (p.eco, p.scope) == key and (p.direct or p.key == "npm:axe-core")),
            key=lambda p: p.name.lower(),
        )
        out += [
            f"#### {title}",
            "",
            "| Package | Range | Locked | Licence (SPDX) | Use |",
            "|---|---|---|---|---|",
        ]
        for pkg in rows:
            use = purposes.get(pkg.key, "")
            lic = pkg.licence
            used_under = election(parse(pkg.licence))
            if used_under:
                lic += f", used under {used_under}"
            out.append(
                f"| [`{pkg.name}`]({pkg.url}) | {f'`{pkg.declared}`' if pkg.declared else 'via a direct dependency'} | {pkg.version} | {lic} | {use} |"
            )
        out.append("")
    return "\n".join(out).rstrip()


def splice_direct(document: str, table: str) -> str:
    start, end = document.find(DIRECT_BEGIN), document.find(DIRECT_END)
    if start < 0 or end < start:
        sys.exit(f"THIRD_PARTY.md needs the markers {DIRECT_BEGIN!r} and {DIRECT_END!r}")
    return document[: start + len(DIRECT_BEGIN)] + "\n\n" + table + "\n\n" + document[end:]


def render_bundled(packages: list[Pkg], supplementary: dict) -> str:
    """Licence texts of everything that is served to browsers: the notices MIT, BSD, ISC, Apache and OFL ask to keep."""
    shipped = sorted(
        (p for p in packages if p.eco == "npm" and p.scope == "browser"), key=lambda p: p.name.lower()
    )
    out = [
        "Licences of the third-party code and fonts that Doory serves to browsers",
        "",
        "Generated by licenses/audit.py --write from the licence files of the installed npm packages. It lists the packages",
        "in the production bundle (code, fonts, WebAssembly). Doory itself is under the Attribution Assurance License (LICENSE).",
        "The WebAssembly"
        "binary of onnxruntime-web is built by Microsoft; its own third-party components are listed in",
        "https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt",
        "",
    ]
    seen: dict[str, str] = {}
    for pkg in shipped:
        out += ["=" * 100, f"{pkg.name} {pkg.version}  [{pkg.licence}]  {pkg.url}", "=" * 100, ""]
        if not pkg.texts:
            extra = supplementary.get(pkg.name, {})
            out += [
                extra.get("note")
                or f"The package carries no licence file; its package.json declares {pkg.licence}.",
                "",
            ]
            if extra.get("text"):
                out += [extra["text"], ""]
            continue
        for file_name, text in pkg.texts.items():
            body = text.strip()
            digest = hashlib.sha256(body.encode()).hexdigest()
            if digest in seen:
                out += [f"[{file_name}: identical to the licence text of {seen[digest]}]", ""]
                continue
            seen[digest] = pkg.name
            out += [f"--- {file_name} ---", "", body, ""]
    return "\n".join(out).rstrip() + "\n"


# --------------------------------------------------------------------------------------------- manifest checks


def check_manifests() -> list[str]:
    problems: list[str] = []
    third = THIRD_PARTY.read_text(encoding="utf-8")
    data = ROOT / "backend" / "data"

    def need(text: str, why: str) -> None:
        if text not in third:
            problems.append(f"THIRD_PARTY.md does not mention {text!r} ({why})")

    elements = json.loads((data / "element_packs.json").read_text(encoding="utf-8"))
    notice_licences = {"MIT", "ISC", "Apache-2.0", "OFL-1.1", "BSD-2-Clause", "BSD-3-Clause"}
    for pack in elements["packs"]:
        spdx = pack.get("license", {}).get("spdx", "")
        if not spdx or not pack.get("license", {}).get("url"):
            problems.append(f"element pack {pack['id']}: licence spdx/url missing")
            continue
        if not is_permissive(parse(spdx)):
            problems.append(f"element pack {pack['id']}: licence {spdx} is not permissive")
        if set(atoms(parse(spdx))) & notice_licences and not pack.get("attribution"):
            problems.append(f"element pack {pack['id']}: {spdx} needs an attribution notice")
        source = pack.get("source", {})
        if source.get("type") == "npm":
            need(f"{source['package']}@{source['version']}", f"source of pack {pack['id']}")
        elif source.get("type") == "urls":
            need(f"element_pack_files/{source['index']}", f"source of pack {pack['id']}")
        elif source.get("type") == "generated":
            need("generate_graphics.py", "generated packs")
        else:
            problems.append(f"element pack {pack['id']}: unknown source type {source.get('type')!r}")
        need(f'"{pack["name"]}"', f"pack name of {pack['id']}") if source.get("type") != "generated" else None
    for index in sorted((data / "element_pack_files").glob("*.json")):
        files = json.loads(index.read_text(encoding="utf-8"))
        files = files if isinstance(files, list) else files.get("files", [])
        if not files or any(not re.fullmatch(r"[0-9a-f]{64}", f.get("sha256", "")) for f in files):
            problems.append(f"{index.name}: every file needs a pinned sha256")
        need(f"{len(files)} SVG files", f"file count of {index.name}")

    models = json.loads((data / "ml_models.json").read_text(encoding="utf-8"))["models"]
    for model in models:
        licence = model.get("license", {})
        if (
            licence.get("spdx") not in {"MIT", "Apache-2.0"}
            or not licence.get("evidence")
            or not licence.get("holder")
        ):
            problems.append(f"model {model['id']}: licence spdx/holder/evidence incomplete")
        if not re.fullmatch(r"[0-9a-f]{64}", model.get("sha256", "")) or not model.get("urls"):
            problems.append(f"model {model['id']}: pinned sha256 and urls required")
        need(model["file"], f"model file of {model['id']}")

    audio = json.loads((data / "audio_library.json").read_text(encoding="utf-8"))
    if audio["license"]["spdx"] != "CC0-1.0" or not audio["license"].get("holder"):
        problems.append("audio_library.json: licence must be CC0-1.0 with a holder")
    kinds = Counter(track["kind"] for track in audio["tracks"])
    need(f"{kinds['music']} music loops and {kinds['sfx']} sound effects", "audio library size")
    for pack in audio.get("packs", []):
        if pack.get("license", {}).get("spdx") not in {"CC0-1.0", "Unlicense", "LicenseRef-PublicDomain"}:
            problems.append(f"audio pack {pack.get('id')}: only public-domain dedications are allowed")

    fonts = {f["family"] for f in json.loads((data / "popular_fonts.json").read_text(encoding="utf-8"))}
    used: set[str] = set()
    for template in (data / "templates").glob("*.json"):
        if template.name != "manifest.json":
            used |= set(re.findall(r'"fontFamily":\s*"\\?"?([^",\\]+)', template.read_text(encoding="utf-8")))
    for family in sorted(used):
        if family not in fonts:
            problems.append(f"starter templates use {family!r}, which is not in popular_fonts.json")
        need(family, "font used by the starter templates")
    for target in ("LICENSE", "NOTICE"):
        if not (ROOT / target).is_file():
            problems.append(f"{target} is missing")
    licence_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    if not licence_text.startswith("Attribution Assurance License") or "Siam" not in licence_text:
        problems.append("LICENSE must be the Attribution Assurance License with Siam's attribution")
    return problems


# --------------------------------------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--write",
        action="store_true",
        help="rewrite licenses/DEPENDENCIES.md and licenses/bundled-licenses.txt",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail on unknown or undecided licences, a stale inventory, or a THIRD_PARTY.md that disagrees with the manifests",
    )
    parser.add_argument(
        "--no-build",
        action="store_true",
        help="do not build the frontend: treat every non-dev npm package as shipped",
    )
    args = parser.parse_args()
    try:
        import packaging  # noqa: F401
    except ImportError:
        sys.exit(
            "`packaging` is not installed: run this with the backend's virtual environment (it comes with pytest)"
        )

    exceptions = load_exceptions()
    decisions = exceptions["decisions"]
    npm = load_npm(FRONTEND, "build/test")
    interop_names = {p.name for p in npm}
    interop = [p for p in load_npm(INTEROP, "build/test") if p.name not in interop_names]
    for pkg in interop:
        pkg.scope = "build/test"
        pkg.flags.append("only used by the collab interop test client")
    mark_bundle(npm, bundled_names(args.no_build), exceptions["prebundled"])
    pip = load_pip(exceptions["overrides"])
    packages = npm + interop + pip
    node = subprocess.run(["node", "--version"], capture_output=True, text=True, check=False).stdout.strip()  # noqa: S607
    notes = {
        "environment": f"Read from {len(npm) + len(interop)} npm packages (Node {node}) and {len(pip)} Python packages (Python {sys.version.split()[0]}) at generation time."
    }

    inventory = render_inventory(packages, decisions, notes)
    bundled = render_bundled(npm, exceptions["supplementary"])
    third_party = splice_direct(
        THIRD_PARTY.read_text(encoding="utf-8"), render_direct(packages, exceptions["purposes"])
    )
    if args.write:
        INVENTORY.write_text(inventory, encoding="utf-8")
        BUNDLED.write_text(bundled, encoding="utf-8")
        THIRD_PARTY.write_text(third_party, encoding="utf-8")
        print(
            f"wrote {INVENTORY.relative_to(ROOT)}, {BUNDLED.relative_to(ROOT)} and the dependency tables of THIRD_PARTY.md"
        )
    if args.check:
        problems = review(packages, decisions, exceptions["text_reviewed"])
        stale = [k for k in decisions if k not in {p.key for p in packages}]
        problems += [
            f"exceptions.json has a decision for {k}, which is no longer a dependency" for k in stale
        ]
        committed = INVENTORY.read_text(encoding="utf-8") if INVENTORY.is_file() else ""
        if f"signature: {signature(group_platform_builds(packages))}" not in committed:
            problems.append("licenses/DEPENDENCIES.md is out of date: run `python licenses/audit.py --write`")
        if not BUNDLED.is_file():
            problems.append(
                "licenses/bundled-licenses.txt is missing: run `python licenses/audit.py --write`"
            )
        elif {p.name for p in npm if p.scope == "browser"} != set(
            re.findall(r"^(\S+) \S+  \[", BUNDLED.read_text(encoding="utf-8"), re.M)
        ):
            problems.append(
                "licenses/bundled-licenses.txt does not list the packages now shipped to browsers: run `python licenses/audit.py --write`"
            )
        if third_party != THIRD_PARTY.read_text(encoding="utf-8"):
            problems.append(
                "the dependency tables of THIRD_PARTY.md are out of date: run `python licenses/audit.py --write`"
            )
        problems += [
            f"{p.key}: a direct dependency needs a one-line `purposes` entry in licenses/exceptions.json"
            for p in packages
            if p.direct and p.key not in exceptions["purposes"]
        ]
        problems += check_manifests()
        for problem in problems:
            print(f"FAIL {problem}")
        print(
            "licence check: "
            + ("FAILED" if problems else f"ok ({len(packages)} packages, manifests consistent)")
        )
        return 1 if problems else 0
    if not args.write:
        print(inventory)
    return 0


if __name__ == "__main__":
    sys.exit(main())
