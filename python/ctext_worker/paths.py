"""文件路径与格式判定 —— `parse_txt` / `parse_epub` 共用的最小工具。

放在独立模块而不是 `parse_txt` 里，是因为 `parse_epub` 也要用同一套校验，
让后者 import 前者会把「TXT 解析」变成「所有解析」的基础依赖，方向反了。

**错误文案一律不含路径本身**：脱敏要求（`docs/产品文档.md`）规定
日志与错误提示不出现绝对路径，路径只进 `detail`，且由调用方决定是否展示。
"""

from __future__ import annotations

import os

from rpc import ERROR_INVALID_ARGUMENT, ERROR_NOT_FOUND, WorkerError

# D1 决策：只认 txt / epub，MOBI/AZW3/PDF 全部排除
SUPPORTED_FORMATS = {".txt": "txt", ".epub": "epub"}

# Windows 路径长度上限 32767，但真实文件系统路径极少超过 4096；
# 超长入参直接拒掉，避免把异常路径丢给 os.stat
MAX_PATH_LEN = 4096


def require_path(params: dict) -> str:
    """校验并返回存在的文件路径。"""
    path = params.get("path")
    if not isinstance(path, str) or not path.strip():
        raise WorkerError(ERROR_INVALID_ARGUMENT, "缺少 path")
    if len(path) > MAX_PATH_LEN:
        raise WorkerError(ERROR_INVALID_ARGUMENT, "路径过长")
    if not os.path.isfile(path):
        raise WorkerError(ERROR_NOT_FOUND, "文件不存在或无法访问")
    return path


def format_of(path: str) -> str | None:
    """按扩展名判定格式。不支持的返回 None。"""
    return SUPPORTED_FORMATS.get(os.path.splitext(path)[1].lower())


def require_dir(params: dict, key: str) -> str | None:
    """校验可选的输出目录参数。给了就必须是绝对路径，避免相对路径跟着 cwd 乱跑。"""
    value = params.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise WorkerError(ERROR_INVALID_ARGUMENT, f"{key} 必须是非空字符串")
    if len(value) > MAX_PATH_LEN:
        raise WorkerError(ERROR_INVALID_ARGUMENT, "路径过长")
    if not os.path.isabs(value):
        raise WorkerError(ERROR_INVALID_ARGUMENT, f"{key} 必须是绝对路径")
    return value
