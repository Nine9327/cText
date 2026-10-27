"""NDJSON 帧协议：帧构造、错误码、方法注册表、带锁的 stdout 写入。

约束（与 src/main/bridge/protocol.ts 一一对应）：
- **一行一帧**，UTF-8，分隔符固定 `\\n`（不用 `\\r\\n`，Windows 下 reconfigure 已处理）
- 响应帧必须有 `id`；事件帧只有 `event`，没有 `id`
- 除 stdout 上的协议帧外，**任何输出都走 stderr**。stdout 里多打一行普通文本
  会让主进程的解析器收到坏帧（虽然能容错，但会刷 warn 日志）
- 错误码与 TS 侧 ERROR_CODES 保持一致，主进程据此映射成 AppError
"""

import json
import sys
import threading
import traceback
from typing import Any, Callable

ERROR_INVALID_ARGUMENT = "E_INVALID_ARGUMENT"
ERROR_NOT_IMPLEMENTED = "E_NOT_IMPLEMENTED"
ERROR_NOT_FOUND = "E_NOT_FOUND"
ERROR_CONFLICT = "E_CONFLICT"
ERROR_IO = "E_IO"
ERROR_TIMEOUT = "E_TIMEOUT"
ERROR_INTERNAL = "E_INTERNAL"


class WorkerError(Exception):
    """业务层可抛的「已知失败」。code 会原样带回主进程，message 直接展示给用户。"""

    def __init__(self, code: str, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


# ---------------------------------------------------------------- stdout

_write_lock = threading.Lock()


def write_line(text: str) -> None:
    """写一整行到 stdout 并立即 flush。多线程共用一把锁，避免帧被截断交织。"""
    with _write_lock:
        sys.stdout.write(text + "\n")
        sys.stdout.flush()


def write_frame(frame: dict[str, Any]) -> None:
    # ensure_ascii=False：中文按 UTF-8 原样输出，帧更小也更好在日志里读
    write_line(json.dumps(frame, ensure_ascii=False, separators=(",", ":")))


def emit_event(event: str, data: Any = None) -> None:
    """向主进程推事件（导入进度等），无 id，不期待响应。"""
    write_frame({"event": event, "data": data})


def log(message: str) -> None:
    """诊断日志一律走 stderr，主进程按行转发到自己的日志里。"""
    sys.stderr.write(f"[worker] {message}\n")
    sys.stderr.flush()


# ---------------------------------------------------------------- 方法注册表

Handler = Callable[[dict[str, Any]], Any]
_registry: dict[str, Handler] = {}


def method(name: str) -> Callable[[Handler], Handler]:
    """注册一个可被主进程调用的方法。name 与文档 §3.5 的方法清单一致。"""

    def deco(fn: Handler) -> Handler:
        if name in _registry:
            raise RuntimeError(f"方法重复注册: {name}")
        _registry[name] = fn
        return fn

    return deco


def registered_methods() -> list[str]:
    return sorted(_registry)


def dispatch(name: str, params: Any) -> Any:
    fn = _registry.get(name)
    if fn is None:
        raise WorkerError(ERROR_NOT_IMPLEMENTED, f"未知方法: {name}")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise WorkerError(ERROR_INVALID_ARGUMENT, "params 必须是对象")
    return fn(params)


def error_detail(err: BaseException) -> str | None:
    """只把异常类型与末行带回，完整堆栈留在 stderr。"""
    frames = traceback.format_exception_only(type(err), err)
    return frames[-1].strip() if frames else None
