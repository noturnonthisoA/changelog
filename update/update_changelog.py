#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = REPO_ROOT / "changelog"

VERSION_ID_RE = re.compile(r"^\d{4}\.\d{2}\.\d{2}$")
VERSION_TEMPLATE = """# {version_id}
版本: 0.0.0
摘要: 本期更新摘要
## 通用功能 | General
- 功能名: 描述 | Feature: Description
"""

HEADER_RE = re.compile(r"^#\s*(.*)$")
SECTION_RE = re.compile(r"^##\s*(.*)$")
META_RE = re.compile(r"^\s*([^:：]+?)\s*[:：]\s*(.*)$")
UNORDERED_ENTRY_RE = re.compile(r"^[-*+](?:\s+|$)")
ORDERED_ENTRY_RE = re.compile(r"^\d+\.\s*")
DATE_RE = re.compile(r"(\d{4})\D+(\d{1,2})\D+(\d{1,2})")
COMPACT_DATE_RE = re.compile(r"(\d{4})(\d{2})(\d{2})")

CANONICAL_META = {
    "badge": "badge",
    "label": "badge",
    "tag": "badge",
    "标签": "badge",
    "标记": "badge",
    "version": "version",
    "ver": "version",
    "版本": "version",
    "版本号": "version",
    "summary": "summary",
    "desc": "summary",
    "description": "summary",
    "摘要": "summary",
    "说明": "summary",
    "mode": "mode",
    "模式": "mode",
}

MODE_ALIASES = {
    "rift": "rift",
    "峡谷": "rift",
    "classic": "classic",
    "经典": "classic",
}
DEFAULT_MODE = "rift"


def normalize_mode(value: str) -> str | None:
    return MODE_ALIASES.get((value or "").strip().lower())


@dataclass
class ParsedVersion:
    id: str
    file: str
    path: Path
    date: str = ""
    badge: str | None = None
    version: str | None = None
    summary: str | None = None
    mode: str = DEFAULT_MODE
    mode_set: bool = False
    count: int = 0
    sections: list[str] = field(default_factory=list)
    has_header: bool = False
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


@dataclass
class BuildResult:
    manifest: dict | None
    changed: bool = False
    written: bool = False
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# 解析
def is_entry_line(line: str) -> bool:
    return bool(UNORDERED_ENTRY_RE.match(line) or ORDERED_ENTRY_RE.match(line))


def parse_version_text(text: str, file_name: str, path: Path) -> ParsedVersion:
    stem = Path(file_name).stem
    version = ParsedVersion(id=stem, file=file_name, path=path)
    first_content_done = False
    in_meta = True
    for lineno, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("//"):
            continue

        if not first_content_done:
            first_content_done = True
            if line.startswith("#") and not line.startswith("##"):
                title = line[1:].strip()
                if title:
                    version.id = title
                    version.has_header = True
                else:
                    version.warnings.append(
                        f"第 {lineno} 行：版本头为空，已回退使用文件名「{stem}」"
                    )
                continue
            version.warnings.append(
                f"缺少版本头「# <版本 id>」，已回退使用文件名「{stem}」作为版本 id"
            )

        if line.startswith("##"):
            in_meta = False
            name = line[2:].strip()
            if not name:
                version.warnings.append(f"第 {lineno} 行：分区名为空，已跳过")
                continue
            if "|" in name and " | " not in name:
                version.warnings.append(
                    f"第 {lineno} 行：分区名建议使用「名称 | English Name」（| 两侧空格）"
                )
            version.sections.append(name)
            continue

        if line.startswith("#"):
            version.warnings.append(f"第 {lineno} 行：多余/重复的版本头行，已忽略")
            continue

        if is_entry_line(line):
            version.count += 1
            if in_meta:
                version.warnings.append(
                    f"第 {lineno} 行：条目行出现在第一个分区之前（仍计入条目数），建议补一个 ## 分区标题"
                )
            continue

        if in_meta:
            match = META_RE.match(line)
            if match:
                key = match.group(1).strip()
                value = match.group(2).strip()
                canonical = CANONICAL_META.get(key.lower())
                if canonical is None:
                    version.warnings.append(
                        f"第 {lineno} 行：未知的元信息键「{key}」，已忽略"
                    )
                    continue
                if canonical == "mode":
                    normalized = normalize_mode(value)
                    if normalized is None:
                        version.errors.append(
                            f"第 {lineno} 行：模式取值非法「{value}」"
                            f"（应为 峡谷/rift 或 经典/classic）"
                        )
                        continue
                    if version.mode_set:
                        version.warnings.append(
                            f"第 {lineno} 行：元信息键「{key}」重复，后值覆盖前值"
                        )
                    version.mode = normalized
                    version.mode_set = True
                    continue
                if getattr(version, canonical):
                    version.warnings.append(
                        f"第 {lineno} 行：元信息键「{key}」重复，后值覆盖前值"
                    )
                setattr(version, canonical, value or None)
                continue
            preview = line if len(line) <= 40 else line[:40] + "…"
            version.errors.append(
                f"第 {lineno} 行：无法解析的元信息行「{preview}」（应为 key: value）"
            )
            continue

        preview = line if len(line) <= 40 else line[:40] + "…"
        version.warnings.append(
            f"第 {lineno} 行：无法识别为条目，已忽略（不计入条目数）「{preview}」"
        )

    if not version.has_header:
        version.id = stem
    version.date = version.id
    return version


def parse_file(path: Path) -> ParsedVersion:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as exc:
        parsed = ParsedVersion(id=path.stem, file=path.name, path=path)
        parsed.errors.append(f"无法按 UTF-8 读取文件：{exc}")
        parsed.date = parsed.id
        return parsed
    except OSError as exc:
        parsed = ParsedVersion(id=path.stem, file=path.name, path=path)
        parsed.errors.append(f"无法读取文件：{exc}")
        parsed.date = parsed.id
        return parsed
    return parse_version_text(text, path.name, path)


def scan_data_dir(data_dir: Path) -> tuple[list[ParsedVersion], list[str], list[str]]:
    versions: list[ParsedVersion] = []
    errors: list[str] = []
    warnings: list[str] = []
    data_dir = Path(data_dir)
    if not data_dir.exists():
        errors.append(f"数据目录不存在：{data_dir}")
        return versions, errors, warnings
    if not data_dir.is_dir():
        errors.append(f"数据目录不是文件夹：{data_dir}")
        return versions, errors, warnings

    files = sorted(
        (p for p in data_dir.iterdir() if p.is_file() and p.suffix.lower() == ".txt"),
        key=lambda p: p.name,
    )
    if not files:
        errors.append(f"数据目录为空：{data_dir} 下没有任何 .txt 版本文件")
        return versions, errors, warnings

    seen: dict[str, ParsedVersion] = {}
    for path in files:
        parsed = parse_file(path)
        versions.append(parsed)
        for warning in parsed.warnings:
            warnings.append(f"{path.name}: {warning}")
        for error in parsed.errors:
            errors.append(f"{path.name}: {error}")
        if parsed.has_header and parsed.id != path.stem:
            warnings.append(
                f"{path.name}: 版本头「{parsed.id}」与文件名「{path.stem}」不一致（file/id 以版本头为准）"
            )
        if parsed.id in seen:
            errors.append(
                f"重复的版本 id「{parsed.id}」：{seen[parsed.id].file} 与 {path.name}"
            )
        else:
            seen[parsed.id] = parsed
    return versions, errors, warnings


def date_sort_key(version_id: str) -> tuple[int, tuple[int, ...], str]:
    match = DATE_RE.search(version_id) or COMPACT_DATE_RE.search(version_id)
    if match:
        return (1, (int(match.group(1)), int(match.group(2)), int(match.group(3))), version_id)
    return (0, (), version_id)


def sort_versions(versions: list[ParsedVersion]) -> list[ParsedVersion]:
    return sorted(versions, key=lambda v: date_sort_key(v.id), reverse=True)


def make_manifest(versions: list[ParsedVersion], generated_at: str | None = None) -> dict:
    ordered = sort_versions(versions)
    entries = []
    for index, version in enumerate(ordered):
        entries.append(
            {
                "id": version.id,
                "file": version.file,
                "date": version.date or version.id,
                "latest": index == 0,
                "mode": version.mode,
                "badge": version.badge,
                "version": version.version,
                "summary": version.summary,
                "count": version.count,
            }
        )
    return {
        "generatedAt": generated_at or local_iso_now(),
        "count": len(entries),
        "versions": entries,
    }


def local_iso_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def render_manifest(manifest: dict) -> str:
    return json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"


# 写入
def atomic_write_text(path: Path, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def load_existing_manifest(out_path: Path) -> dict | None:
    try:
        data = json.loads(Path(out_path).read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def build(
    data_dir: Path | str | None = None,
    out_path: Path | str | None = None,
    quiet: bool = False,
    write: bool = True,
) -> BuildResult:
    data_dir_path = Path(data_dir) if data_dir else DEFAULT_DATA_DIR
    out_path_obj = Path(out_path) if out_path else data_dir_path / "index.json"
    versions, errors, warnings = scan_data_dir(data_dir_path)
    result = BuildResult(manifest=None, errors=errors, warnings=warnings)
    if errors:
        return result

    manifest = make_manifest(versions)
    existing = load_existing_manifest(out_path_obj)
    if (
        isinstance(existing, dict)
        and existing.get("count") == manifest["count"]
        and existing.get("versions") == manifest["versions"]
        and isinstance(existing.get("generatedAt"), str)
        and existing["generatedAt"]
    ):
        manifest["generatedAt"] = existing["generatedAt"]

    text = render_manifest(manifest)
    old_text: str | None = None
    if out_path_obj.exists():
        try:
            old_text = out_path_obj.read_text(encoding="utf-8")
        except OSError:
            old_text = None
    result.manifest = manifest
    result.changed = old_text != text
    if write and result.changed:
        atomic_write_text(out_path_obj, text)
        result.written = True
    return result


# CLI
def _configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, OSError, ValueError):
            pass


def _status_line(version: ParsedVersion) -> str:
    extras = [f"mode={version.mode}"]
    if version.badge:
        extras.append(f"badge={version.badge}")
    if version.version:
        extras.append(f"version={version.version}")
    if version.summary:
        extras.append(f"summary={version.summary}")
    suffix = f"  ({', '.join(extras)})" if extras else ""
    return f"  {version.id:<12} {version.count:>3} 条  {version.file}{suffix}"


def print_report(
    result: BuildResult,
    data_dir: Path,
    out_path: Path,
    check_mode: bool,
    quiet: bool,
) -> None:
    mode = "校验（--check）" if check_mode else "生成"
    print(f"[update_changelog] 模式: {mode}")
    print(f"[update_changelog] 数据目录: {data_dir}")
    print(f"[update_changelog] 清单文件: {out_path}")
    manifest = result.manifest
    if result.errors:
        print(f"[update_changelog] 错误 {len(result.errors)} 项：")
        for error in result.errors:
            print(f"  [错误] {error}")
    if result.warnings and not quiet:
        print(f"[update_changelog] 警告 {len(result.warnings)} 项：")
        for warning in result.warnings:
            print(f"  [警告] {warning}")
    if manifest is not None:
        versions = manifest["versions"]
        if not quiet:
            print(f"[update_changelog] 解析到 {manifest['count']} 个版本：")
            for entry in versions:
                summary = entry.get("summary") or ""
                badge = entry.get("badge") or ""
                version = entry.get("version") or ""
                extras = [f"mode={entry.get('mode', 'rift')}"]
                if badge:
                    extras.append(f"badge={badge}")
                if version:
                    extras.append(f"version={version}")
                if summary:
                    extras.append(f"summary={summary}")
                suffix = f"  ({', '.join(extras)})" if extras else ""
                print(f"  {entry['id']:<12} {entry['count']:>3} 条  {entry['file']}{suffix}")
        total = sum(entry["count"] for entry in versions)
        latest = versions[0]["id"] if versions else "-"
        if check_mode:
            print(
                f"[update_changelog] 校验通过：{manifest['count']} 个版本，"
                f"共 {total} 条条目，latest={latest}"
            )
        elif result.written:
            print(
                f"[update_changelog] 已写入 {out_path}"
                f"（{manifest['count']} 个版本，共 {total} 条条目，latest={latest}）"
            )
        else:
            print(
                f"[update_changelog] 清单无变化，未重写 {out_path}"
                f"（{manifest['count']} 个版本，共 {total} 条条目）"
            )
    else:
        print("[update_changelog] 未能生成清单。")


def create_version(data_dir: Path, version_id: str, quiet: bool = False) -> int:
    if not VERSION_ID_RE.match(version_id):
        print(f"[update_changelog] 错误：版本 id 需为 YYYY.MM.DD，收到：{version_id}")
        return 1
    target = Path(data_dir) / f"{version_id}.txt"
    if target.exists():
        print(f"[update_changelog] 错误：文件已存在，未覆盖：{target}")
        return 1
    target.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(target, VERSION_TEMPLATE.format(version_id=version_id))
    if not quiet:
        print(f"[update_changelog] 已新建模板：{target}")
        print("[update_changelog] 记得把上一期的「标签: 最新」删掉，改到本期")
    return 0


def main(argv: list[str] | None = None) -> int:
    _configure_stdio()
    parser = argparse.ArgumentParser(
        prog="update_changelog.py",
        description="扫描 changelog/*.txt 生成 changelog/index.json（SPEC §2/§3）。",
    )
    parser.add_argument(
        "--data-dir",
        default=str(DEFAULT_DATA_DIR),
        help="版本 txt 所在目录（默认：<仓库>/changelog）",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="输出的 index.json 路径（默认：<data-dir>/index.json）",
    )
    parser.add_argument(
        "--new",
        metavar="YYYY.MM.DD",
        help="新建一期日志模板后再刷新清单（不覆盖已有文件）",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="只校验并打印报告，不写文件；发现错误时以非零码退出",
    )
    parser.add_argument("--quiet", action="store_true", help="仅输出必要信息")
    args = parser.parse_args(argv)

    data_dir = Path(args.data_dir)
    out_path = Path(args.out) if args.out else data_dir / "index.json"

    if args.new:
        if args.check:
            print("[update_changelog] 错误：--check 不能和 --new 一起用")
            return 2
        code = create_version(data_dir, args.new, quiet=args.quiet)
        if code != 0:
            return code

    result = build(data_dir=data_dir, out_path=out_path, quiet=args.quiet, write=not args.check)
    if args.check and not result.errors and result.changed:
        result.errors.append(
            f"{out_path.name} 与 changelog/*.txt 不一致，请运行 python update/update_changelog.py 重新生成"
        )
    print_report(result, data_dir, out_path, check_mode=args.check, quiet=args.quiet)

    if result.errors:
        return 1
    if result.manifest is None:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
