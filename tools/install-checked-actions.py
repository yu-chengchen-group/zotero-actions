"""在 Zotero 已关闭时，用仓库源码更新已安装的 Actions & Tags 规则。"""

from __future__ import annotations

import argparse
import configparser
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

RULES = {
    "sync-attachments": "sync-attachments.js",
    "1786529156738-JlgQvNK5": "document2md.js",
    "sync-to-group": "sync-to-group.js",
}
REQUIRED = {"sync-attachments", "1786529156738-JlgQvNK5"}


def default_prefs() -> Path:
    root = Path(os.environ["APPDATA"]) / "Zotero" / "Zotero"
    profiles = configparser.ConfigParser(interpolation=None)
    if not profiles.read(root / "profiles.ini", encoding="utf-8-sig"):
        raise RuntimeError("未找到 Zotero profiles.ini")
    candidates = [
        section for section in profiles.sections()
        if section.startswith("Profile")
    ]
    defaults = [
        section for section in candidates
        if profiles[section].get("Default") == "1"
    ]
    if len(defaults) != 1:
        if len(candidates) == 1:
            defaults = candidates
        else:
            raise RuntimeError("无法唯一定位默认 Zotero Profile")
    profile = profiles[defaults[0]]
    path = Path(profile["Path"])
    if profile.get("IsRelative", "1") == "1":
        path = root / path
    prefs = path / "prefs.js"
    if not prefs.is_file():
        raise RuntimeError("未找到 Zotero prefs.js")
    return prefs


def ensure_stopped() -> None:
    check = subprocess.run(
        [
            "powershell.exe", "-NoProfile", "-Command",
            "if(Get-Process -Name zotero -ErrorAction SilentlyContinue){exit 1}",
        ],
        check=False, capture_output=True,
    )
    if check.returncode != 0:
        raise RuntimeError("Zotero 正在运行；拒绝修改 prefs.js")


def get_rule(line: str, key: str) -> dict:
    prefix = f'user_pref("extensions.actionsTags.rules.{key}", '
    if not line.startswith(prefix) or not line.rstrip().endswith(");"):
        raise ValueError(f"规则行格式无效：{key}")
    encoded = line.strip()[len(prefix):-2]
    value = json.loads(json.loads(encoded))
    if not isinstance(value, dict) or not isinstance(value.get("data"), str):
        raise ValueError(f"规则内容无效：{key}")
    return value


def render_rule(key: str, value: dict) -> str:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return (
        f'user_pref("extensions.actionsTags.rules.{key}", '
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ");"
    )


def install(root: Path) -> None:
    ensure_stopped()
    prefs = default_prefs()
    sources = {
        key: (root / "scripts" / filename).read_text(encoding="utf-8-sig")
        for key, filename in RULES.items()
    }
    original_bytes = prefs.read_bytes()
    existing = original_bytes.decode("utf-8-sig")
    newline = "\r\n" if b"\r\n" in original_bytes else "\n"
    bom = b"\xef\xbb\xbf" if original_bytes.startswith(b"\xef\xbb\xbf") else b""
    lines = existing.splitlines()
    replacement: dict[str, int] = {}

    for key in RULES:
        prefix = f'user_pref("extensions.actionsTags.rules.{key}", '
        indexes = [i for i, line in enumerate(lines) if line.startswith(prefix)]
        if len(indexes) != 1:
            if key in REQUIRED or len(indexes) > 1:
                raise RuntimeError(f"规则缺失或重复：{key}")
            continue
        i = indexes[0]
        value = get_rule(lines[i], key)
        value["data"] = sources[key]
        lines[i] = render_rule(key, value)
        replacement[key] = i

    index_prefix = 'user_pref("extensions.actionsTags.rules", '
    index_lines = [line for line in lines if line.startswith(index_prefix)]
    if len(index_lines) != 1:
        raise RuntimeError("Actions & Tags 规则索引异常")
    index_value = index_lines[0][len(index_prefix):-2]
    indexes = json.loads(json.loads(index_value))
    if any(key not in indexes for key in replacement):
        raise RuntimeError("Actions & Tags 索引缺少已安装规则")

    backup = prefs.with_name(
        f"prefs.js.before-v2-{dt.datetime.now():%Y%m%d-%H%M%S}.bak"
    )
    if backup.exists():
        raise RuntimeError(f"备份已存在：{backup}")
    shutil.copy2(prefs, backup)
    temporary = prefs.with_name("prefs.js.v2-new")
    try:
        temporary.write_bytes(bom + (newline.join(lines) + newline).encode("utf-8"))
        for key, i in replacement.items():
            if get_rule(lines[i], key)["data"] != sources[key]:
                raise RuntimeError(f"脚本校验失败：{key}")
        os.replace(temporary, prefs)
        written = prefs.read_text(encoding="utf-8")
        for key in replacement:
            found = next(
                line for line in written.splitlines()
                if line.startswith(f'user_pref("extensions.actionsTags.rules.{key}", ')
            )
            if get_rule(found, key)["data"] != sources[key]:
                raise RuntimeError(f"写入后校验失败：{key}")
    except Exception:
        if temporary.exists():
            temporary.unlink()
        shutil.copy2(backup, prefs)
        raise

    print("UPDATED_PROFILE=" + str(prefs.parent))
    print("BACKUP=" + str(backup))
    for key in replacement:
        digest = hashlib.sha256(sources[key].encode("utf-8")).hexdigest()
        print(f"UPDATED_RULE={key} SOURCE_SHA256={digest}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source-root", type=Path,
        default=Path(__file__).resolve().parent.parent,
    )
    options = parser.parse_args()
    try:
        install(options.source_root)
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(f"INSTALL_FAILED={error}", file=sys.stderr)
        sys.exit(1)
