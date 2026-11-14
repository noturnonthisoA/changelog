#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_changelog 
import update_champions

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "_site"

CHANGELOG_DIR = REPO_ROOT / "changelog"
DATA_DIR = REPO_ROOT / "data"

DATA_EXCLUDE_NAMES = ("hero_list.js", "master_support.json")

EXPECTED_ASSETS = (
    "css/app.css",
    "css/theme.css",
    "js/app.js",
    "js/config.js",
    "js/i18n.js",
    "js/parser.js",
)

PROTECTED_NAMES = (
    "data",
    "changelog",
    "assets",
    "update",
    ".github",
    ".git",
)

def _configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, OSError, ValueError):
            pass


def human_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


def directory_stats(directory: Path) -> tuple[int, int]:
    files = 0
    total = 0
    for path in directory.rglob("*"):
        if path.is_file():
            files += 1
            try:
                total += path.stat().st_size
            except OSError:
                pass
    return files, total


def is_protected_out(out_dir: Path) -> str | None:
    out_abs = out_dir.absolute()
    repo_abs = REPO_ROOT.resolve()
    try:
        resolved = out_abs.resolve()
    except OSError:
        resolved = out_abs
    if resolved == repo_abs:
        return "不能把仓库根目录作为产物目录"
    if resolved == Path(resolved.anchor):
        return "不能把磁盘根目录作为产物目录"
    if repo_abs.is_relative_to(resolved):
        return "产物目录不能是仓库根目录的上级目录"
    if resolved.name in PROTECTED_NAMES and resolved.parent == repo_abs:
        return f"产物目录不能是仓库内的受保护目录「{resolved.name}/」"
    return None


def validate_inputs() -> list[str]:
    errors: list[str] = []
    index_html = REPO_ROOT / "index.html"
    assets = REPO_ROOT / "assets"
    if not index_html.is_file():
        errors.append(f"缺少必需的入口文件：{index_html}")
    if not assets.is_dir():
        errors.append(f"缺少必需的资源目录：{assets}")
    if not CHANGELOG_DIR.is_dir():
        errors.append(f"缺少必需的日志目录：{CHANGELOG_DIR}")
    else:
        txt_files = [
            p for p in CHANGELOG_DIR.iterdir() if p.is_file() and p.suffix.lower() == ".txt"
        ]
        if not txt_files:
            errors.append(f"日志目录里没有任何 .txt 版本文件：{CHANGELOG_DIR}")
    return errors


def build_site(out_dir: Path, quiet: bool = False) -> int:
    out_dir = Path(out_dir)
    errors = validate_inputs()
    if errors:
        print("[build_site] 错误：必需文件校验失败")
        for error in errors:
            print(f"  [错误] {error}")
        return 1

    index_html = REPO_ROOT / "index.html"
    assets_dir = REPO_ROOT / "assets"

    result = update_changelog.build(
        data_dir=CHANGELOG_DIR,
        out_path=CHANGELOG_DIR / "index.json",
        quiet=quiet,
        write=True,
    )
    if result.errors or result.manifest is None:
        print("[build_site] 错误：生成 changelog/index.json 失败")
        for error in result.errors:
            print(f"  [错误] {error}")
        return 1
    manifest = result.manifest
    if not quiet and result.written:
        print(f"[build_site] 已刷新仓库清单 changelog/index.json（{manifest['count']} 个版本）")

    champ_result = update_champions.build(
        source_dir=DATA_DIR,
        out_path=DATA_DIR / "champions.json",
        quiet=quiet,
    )
    if champ_result.get("errors") or champ_result.get("doc") is None:
        print("[build_site] 错误：生成 data/champions.json 失败")
        for error in champ_result.get("errors") or []:
            print(f"  [错误] {error}")
        return 1
    if not quiet and champ_result.get("written"):
        counts = champ_result.get("counts") or {}
        print(
            f"[build_site] 已刷新英雄目录 data/champions.json"
            f"（峡谷 {counts.get('rift', '?')} / 经典 {counts.get('classic', '?')}）"
        )

    blocked = is_protected_out(out_dir)
    if blocked:
        print(f"[build_site] 错误：拒绝使用该产物目录 —— {blocked}：{out_dir}")
        return 1
    if out_dir.exists():
        if not out_dir.is_dir():
            print(f"[build_site] 错误：产物路径已存在且不是目录：{out_dir}")
            return 1
        shutil.rmtree(out_dir)
        if not quiet:
            print(f"[build_site] 已清空旧产物目录：{out_dir}")
    out_dir.mkdir(parents=True, exist_ok=True)

    shutil.copy2(index_html, out_dir / "index.html")
    shutil.copytree(
        assets_dir,
        out_dir / "assets",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store", "Thumbs.db"),
    )

    out_changelog = out_dir / "changelog"
    out_changelog.mkdir(parents=True, exist_ok=True)
    txt_files = sorted(
        (p for p in CHANGELOG_DIR.iterdir() if p.is_file() and p.suffix.lower() == ".txt"),
        key=lambda p: p.name,
    )
    for entry in txt_files:
        shutil.copy2(entry, out_changelog / entry.name)
    update_changelog.atomic_write_text(
        out_changelog / "index.json", update_changelog.render_manifest(manifest)
    )

    out_data = out_dir / "data"
    out_data.mkdir(parents=True, exist_ok=True)
    shutil.copy2(DATA_DIR / "champions.json", out_data / "champions.json")

    problems: list[str] = []
    if not (out_dir / "index.html").is_file():
        problems.append("产物缺少 index.html")
    if not (out_dir / "assets").is_dir():
        problems.append("产物缺少 assets/")
    if not (out_data / "champions.json").is_file():
        problems.append("产物缺少 data/champions.json（英雄图鉴数据）")
    for excluded in DATA_EXCLUDE_NAMES:
        if (out_data / excluded).exists():
            problems.append(f"产物不应包含 data/{excluded}（仅构建输入）")
    manifest_path = out_changelog / "index.json"
    out_manifest: dict | None = None
    if not manifest_path.is_file():
        problems.append("产物缺少 changelog/index.json")
    else:
        try:
            out_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            problems.append(f"产物 changelog/index.json 无法解析：{exc}")
    if isinstance(out_manifest, dict):
        versions = out_manifest.get("versions") or []
        if len(versions) != len(txt_files):
            problems.append(
                f"产物清单版本数（{len(versions)}）与 txt 文件数（{len(txt_files)}）不一致"
            )
        for entry in versions:
            file_name = entry.get("file")
            if not isinstance(file_name, str) or not (out_changelog / file_name).is_file():
                problems.append(f"产物缺少清单引用的数据文件：{file_name}")
    for relative in EXPECTED_ASSETS:
        if not (out_dir / "assets" / relative).is_file():
            print(f"[build_site] 警告：缺少资源 assets/{relative}（前端可能还未就绪）")
    if problems:
        print("[build_site] 错误：产物校验失败")
        for problem in problems:
            print(f"  [错误] {problem}")
        return 1

    if not quiet:
        root_files = sorted(
            (p for p in out_dir.iterdir() if p.is_file()), key=lambda p: p.name
        )
        for path in root_files:
            print(f"  {path.name:<30} {human_size(path.stat().st_size)}")
        for name in ("assets", "changelog", "data"):
            directory = out_dir / name
            if directory.is_dir():
                files, total = directory_stats(directory)
                print(f"  {name + '/':<30} {files} 个文件, {human_size(total)}")
    file_count = 0
    total_size = 0
    for path in out_dir.rglob("*"):
        if path.is_file():
            file_count += 1
            total_size += path.stat().st_size
    print(f"[build_site] 产物目录: {out_dir}")
    print(f"[build_site] 产物合计: {file_count} 个文件，共 {human_size(total_size)}")
    print("[build_site] 完成")
    return 0


def main(argv: list[str] | None = None) -> int:
    _configure_stdio()
    parser = argparse.ArgumentParser(
        prog="build_site.py",
        description="生成可独立部署的静态站点目录（默认 _site/）。",
    )
    parser.add_argument(
        "--out",
        default=str(DEFAULT_OUT),
        help="产物目录（默认：<仓库>/_site；会被清空重建）",
    )
    parser.add_argument("--quiet", action="store_true", help="仅输出关键信息")
    args = parser.parse_args(argv)
    return build_site(Path(args.out), quiet=args.quiet)


if __name__ == "__main__":
    raise SystemExit(main())
