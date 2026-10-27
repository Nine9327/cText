"""诊断方法，**仅在 CTEXT_WORKER_DEBUG=1 时注册**（主进程只在非打包环境设置该变量）。

存在的理由：桥接层有三件事没法用真实业务方法验证——
  1. 请求超时（需要一个能可控变慢的方法）
  2. 坏帧容错（需要让 worker 主动吐一行非法 JSON）
  3. 崩溃重启（需要让 worker 立刻退出，且不依赖外部 kill 的时序）
所以把它们放在这里，而不是往 parse.* 里塞调试参数。
"""

import os
import time

from rpc import method, write_line

# 单次 sleep 上限，避免自检脚本把自己挂死
MAX_SLEEP_MS = 10_000


@method("debug.sleep")
def sleep(params: dict) -> dict:
    ms = params.get("ms", 0)
    if not isinstance(ms, (int, float)) or ms < 0:
        from rpc import ERROR_INVALID_ARGUMENT, WorkerError

        raise WorkerError(ERROR_INVALID_ARGUMENT, "ms 必须是非负数")
    actual = min(int(ms), MAX_SLEEP_MS)
    time.sleep(actual / 1000)
    return {"sleptMs": actual}


@method("debug.garbage")
def garbage(params: dict) -> dict:
    """向 stdout 直接写一行非 JSON，验证主进程解码器能跳过坏帧继续工作。"""
    write_line('{"broken": this is not json')
    return {"garbageWritten": True}


@method("debug.crash")
def crash(params: dict) -> dict:
    """硬退出进程，模拟崩溃（不发响应帧、不执行清理）。"""
    code = params.get("exitCode", 3)
    os._exit(int(code) if isinstance(code, int) else 3)
