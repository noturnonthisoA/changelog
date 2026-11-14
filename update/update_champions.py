#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE_DIR = REPO_ROOT / "data"
DEFAULT_OUT = REPO_ROOT / "data" / "champions.json"

HERO_LIST_URL = "https://game.gtimg.cn/images/lol/act/img/js/heroList/hero_list.js"

MASTER_SUPPORT_NAME = "master_support.json"
ALIAS_ALT = {"wukong": "monkeyking", "monkeyking": "wukong"}

def _configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, OSError, ValueError):
            pass


def load_hero_doc(path: Path) -> dict[str, Any]:
    text = Path(path).read_text(encoding="utf-8-sig")
    data = json.loads(text)
    if not isinstance(data, dict) or not isinstance(data.get("hero"), list):
        raise ValueError(f"英雄表结构异常（缺少 hero 数组）：{path}")
    return data


def load_json(path: Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def master_support_path(source_dir: Path | str) -> Path:
    return Path(source_dir) / MASTER_SUPPORT_NAME


def load_master_sets(source_dir: Path | str) -> tuple[set[str], set[str], dict[str, set[str]]]:
    src = Path(source_dir)
    path = master_support_path(src)
    data = load_json(path)
    if not isinstance(data, list):
        raise ValueError(f"master_support.json 应为英雄别名数组：{path}")
    keys: set[str] = set()
    extras: dict[str, set[str]] = {}
    for item in data:
        if isinstance(item, str):
            alias = item.strip().lower()
            if alias:
                keys.add(alias)
            continue
        if isinstance(item, dict):
            alias = str(item.get("alias") or "").strip().lower()
            if not alias:
                raise ValueError(f"master_support.json 的对象条目缺少 alias：{item!r}")
            keys.add(alias)
            names = item.get("names") or []
            if isinstance(names, str):
                names = [names]
            bucket = extras.setdefault(alias, set())
            for name in names:
                if isinstance(name, str) and name.strip():
                    bucket.add(name.strip())
            continue
        raise ValueError(f"master_support.json 的条目应为字符串或对象：{item!r}")
    return keys, set(keys), extras


def refresh_sources(source_dir: Path, quiet: bool = False) -> list[str]:
    source_dir = Path(source_dir)
    source_dir.mkdir(parents=True, exist_ok=True)
    if not quiet:
        print(f"[update_champions] 下载 {HERO_LIST_URL}")
    request = Request(HERO_LIST_URL, headers={"User-Agent": "MasterAio-build-champions/1.0"})
    with urlopen(request, timeout=30) as response:  # noqa: S310 - 固定可信来源
        payload = response.read()
    target = source_dir / "hero_list.js"
    target.write_bytes(payload)
    if not quiet:
        print(f"[update_champions] 已更新 {target}（{len(payload)} 字节）")
    return [str(target)]


def build_champions_doc(
    hero_doc: dict[str, Any],
    master_rift: set[str],
    master_classic: set[str],
    alias_extra: dict[str, set[str]],
    generated_at: str | None = None,
) -> dict[str, Any]:
    heroes = hero_doc["hero"]
    meta: dict[str, dict[str, Any]] = {
        str(hero["alias"]).lower(): hero for hero in heroes if isinstance(hero, dict) and hero.get("alias")
    }

    def resolve(name: str) -> dict[str, Any] | None:
        hero = meta.get(name.lower())
        if hero is not None:
            return hero
        alt = ALIAS_ALT.get(name.lower())
        if alt is not None:
            return meta.get(alt)
        return None

    champions: dict[str, dict[str, Any]] = {}

    def add(name: str) -> None:
        hero = resolve(name)
        key = str(hero["alias"]) if hero else name
        if key in champions:
            return
        keywords: set[str] = set()
        if hero:
            for piece in str(hero.get("keywords") or "").split(","):
                piece = piece.strip()
                if piece:
                    keywords.add(piece)
            keywords.add(str(hero["alias"]))
            keywords.add(str(hero.get("title") or ""))
            keywords.add(str(hero.get("name") or ""))
        keywords.add(name)
        keywords.add(key)
        keywords.update(alias_extra.get(key, set()))
        keywords.update(alias_extra.get(name, set()))
        keywords.discard("")
        hero_id = str(hero.get("heroId") or "") if hero else ""
        alias = str(hero["alias"]) if hero else name
        champions[key] = {
            "alias": key,
            "name": (str(hero.get("title")) if hero else name),
            "title": (str(hero.get("name")) if hero else ""),
            "en": (str(hero.get("alias")) if hero else name),
            "heroId": hero_id,
            "portrait": (
                f"https://game.gtimg.cn/images/lol/act/img/champion/{alias}.png" if hero else ""
            ),
            "splash": (
                f"https://game.gtimg.cn/images/lol/act/img/skin/big{hero_id}000.jpg" if hero_id else ""
            ),
            "keywords": sorted(keywords, key=lambda s: (len(s), s)),
        }

    for name in sorted(master_rift | master_classic):
        add(name)
    ordered = sorted(champions, key=lambda key: (champions[key]["name"], key))

    source = {
        "heroListVersion": str(hero_doc.get("version") or ""),
        "heroListFileTime": str(hero_doc.get("fileTime") or ""),
        "masterSupport": MASTER_SUPPORT_NAME,
    }

    return {
        "generatedAt": generated_at or local_iso_now(),
        "source": source,
        "champions": {key: champions[key] for key in ordered},
    }


def local_iso_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def render_champions(doc: dict[str, Any]) -> str:
    return json.dumps(doc, ensure_ascii=False, indent=2) + "\n"


# 校验
def validate_doc(
    doc: dict[str, Any],
    hero_doc: dict[str, Any],
) -> list[str]:
    errors: list[str] = []
    champions = doc.get("champions")
    if not isinstance(champions, dict):
        return ["champions 不是对象"]
    if not champions:
        return ["champions 为空（检查 master_support.json 是否有英雄别名）"]

    meta = {str(h["alias"]).lower(): h for h in hero_doc["hero"] if h.get("alias")}
    for key, value in champions.items():
        if not (value.get("name") or value.get("en")):
            errors.append(f"champions.{key} 缺少名称")
            continue
        if str(key).lower() not in meta and ALIAS_ALT.get(str(key).lower()) not in meta:
            errors.append(f"champions.{key} 在 hero 表里找不到元数据")

    return errors


def _without_generated_at(doc: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in doc.items() if key != "generatedAt"}


# 写入
def atomic_write_text(path: Path, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
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


def load_existing_doc(out_path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(Path(out_path).read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def build(
    source_dir: Path | str | None = None,
    out_path: Path | str | None = None,
    refresh: bool = False,
    check: bool = False,
    quiet: bool = False,
) -> dict[str, Any]:
    src = Path(source_dir) if source_dir else DEFAULT_SOURCE_DIR
    out = Path(out_path) if out_path else DEFAULT_OUT

    errors: list[str] = []
    warnings: list[str] = []

    if refresh:
        try:
            refresh_sources(src, quiet=quiet)
        except Exception as exc:  # noqa: BLE001 - 网络失败不阻塞，用本地快照继续
            warnings.append(f"刷新英雄表失败：{exc}（改用本地 data/hero_list.js）")

    for required in (src / "hero_list.js", master_support_path(src)):
        if not Path(required).is_file():
            errors.append(f"缺少必需输入文件：{required}")
    if errors:
        return {"doc": None, "errors": errors, "warnings": warnings, "written": False, "changed": False}

    try:
        hero_doc = load_hero_doc(src / "hero_list.js")
        master_rift, master_classic, alias_extra = load_master_sets(src)
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        errors.append(f"读取输入失败：{exc}")
        return {"doc": None, "errors": errors, "warnings": warnings, "written": False, "changed": False}

    doc = build_champions_doc(hero_doc, master_rift, master_classic, alias_extra)
    errors.extend(validate_doc(doc, hero_doc))

    existing = load_existing_doc(out)
    if check:
        if existing is None:
            errors.append(f"待校验的 champions.json 缺失或无法解析：{out}")
        elif _without_generated_at(existing) != _without_generated_at(doc):
            errors.append(
                f"{out} 与当前源快照生成结果不一致（忽略 generatedAt 后仍有差异）；"
                f"请运行 python update/update_champions.py 重新生成"
            )
        return {
            "doc": doc,
            "errors": errors,
            "warnings": warnings,
            "written": False,
            "changed": False,
        }

    if errors:
        return {"doc": doc, "errors": errors, "warnings": warnings, "written": False, "changed": False}

    if (
        existing is not None
        and _without_generated_at(existing) == _without_generated_at(doc)
        and isinstance(existing.get("generatedAt"), str)
        and existing["generatedAt"]
    ):
        doc["generatedAt"] = existing["generatedAt"]

    text = render_champions(doc)
    old_text: str | None = None
    if out.exists():
        try:
            old_text = out.read_text(encoding="utf-8")
        except OSError:
            old_text = None
    changed = old_text != text
    if changed:
        atomic_write_text(out, text)
    return {
        "doc": doc,
        "errors": errors,
        "warnings": warnings,
        "written": changed,
        "changed": changed,
        "counts": {"champions": len(doc["champions"])},
    }


def print_report(result: dict[str, Any], check_mode: bool, quiet: bool) -> None:
    doc = result.get("doc")
    print("[update_champions] 模式: " + ("校验（--check）" if check_mode else "生成"))
    if result.get("errors"):
        print(f"[update_champions] 错误 {len(result['errors'])} 项：")
        for error in result["errors"]:
            print(f"  [错误] {error}")
    if result.get("warnings") and not quiet:
        print(f"[update_champions] 警告 {len(result['warnings'])} 项：")
        for warning in result["warnings"]:
            print(f"  [警告] {warning}")
    if doc is not None:
        champs = len(doc["champions"])
        if not quiet:
            print(f"[update_champions] 英雄 {champs} 个")
            print(f"[update_champions] 英雄表版本: {doc['source']['heroListVersion']}")
        if check_mode and not result.get("errors"):
            print(f"[update_champions] 校验通过：{champs} 个英雄")
        elif check_mode:
            print("[update_champions] 校验失败")
        elif result.get("written"):
            print(f"[update_champions] 已写入 data/champions.json（{champs} 个英雄）")
        else:
            print(f"[update_champions] 无变化，未重写（{champs} 个英雄）")


def main(argv: list[str] | None = None) -> int:
    _configure_stdio()
    parser = argparse.ArgumentParser(
        prog="update_champions.py",
        description="更新英雄图鉴数据 data/champions.json（英雄表 → 图鉴）。",
    )
    parser.add_argument("--source-dir", default=str(DEFAULT_SOURCE_DIR), help="英雄数据目录（默认 data/）")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="输出 champions.json（默认 data/champions.json）")
    parser.add_argument("--offline", action="store_true", help="不联网，只用本地 data/hero_list.js 重建")
    parser.add_argument("--check", action="store_true", help="只校验（结构 + 与已提交文件一致），不写文件、不联网")
    parser.add_argument("--quiet", action="store_true", help="仅输出必要信息")
    args = parser.parse_args(argv)

    result = build(
        source_dir=args.source_dir,
        out_path=args.out,
        refresh=not args.offline and not args.check,
        check=args.check,
        quiet=args.quiet,
    )
    print_report(result, check_mode=args.check, quiet=args.quiet)
    if result.get("errors"):
        return 1
    if result.get("doc") is None:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
