"""ctext-worker 入口：stdin 读 NDJSON 请求，stdout 写 NDJSON 响应/事件。

设计要点：
- **stdout 只走协议帧**，任何 print/告警都进 stderr（主进程按行收集到日志）
- **并发执行**：4 线程池。导入流水线会并发 4 个请求（文档 §3.10），单线程串行
  会让吞吐退化成 1/4；帧写入由 rpc._write_lock 串行化，响应顺序不保证也没关系，
  协议靠 id 匹配
- **stdin EOF = 退出**：主进程死掉时管道关闭，worker 自行退出，不留孤儿进程
- `-u` 启动 + 每次写后 flush：不做行缓冲，避免主进程等到缓冲满才收到响应
"""

import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

# 允许 `python main.py` 与 PyInstaller 两种方式都按同级模块导入
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rpc import (  # noqa: E402  (必须在 sys.path 调整之后导入)
    ERROR_INTERNAL,
    ERROR_INVALID_ARGUMENT,
    WorkerError,
    dispatch,
    error_detail,
    log,
    registered_methods,
    write_frame,
)
from version import PROTOCOL, __version__  # noqa: E402

# 注册方法（导入即注册）
import methods.health  # noqa: E402,F401

# 诊断方法只在开发/自检时存在：主进程仅在非打包环境设置 CTEXT_WORKER_DEBUG=1，
# 生产包里这些方法压根不会被注册，暴露面为零
if os.environ.get("CTEXT_WORKER_DEBUG") == "1":
    import methods.debug  # noqa: E402,F401

WORKERS = 4

# EOF 后等待在途请求的最大时间：不能无限等（大文件解析可能很久），
# 也不能立刻退出（管道里已经读到的请求应当得到响应，否则调用方只看到「进程没了」）
DRAIN_GRACE_SECONDS = 0.8

_inflight = 0
_idle = threading.Condition()


def _reconfigure_stdio() -> None:
    """Windows 下管道默认用 ANSI 代码页（中文机器是 cp936），必须强制 UTF-8。

    主进程也会设 PYTHONIOENCODING，这里再兜一层：直接 `python main.py` 手测时同样正确。
    """
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace", newline="\n")
        except (AttributeError, ValueError):  # 被重定向成不可重配置的对象
            pass


def _handle(req: object) -> None:
    """在池线程里处理一个请求帧。任何异常都必须转成响应帧，不能让线程静默死掉。"""
    global _inflight
    with _idle:
        _inflight += 1
    try:
        _dispatch_frame(req)
    finally:
        with _idle:
            _inflight -= 1
            _idle.notify_all()


def _dispatch_frame(req: object) -> None:
    if not isinstance(req, dict):
        log("请求帧不是对象，已丢弃")
        return

    rid = req.get("id")
    if not isinstance(rid, str) or not rid:
        # 没有 id 就没法回应，只能记日志
        log("请求帧缺少 id，已丢弃")
        return

    name = req.get("method")
    if not isinstance(name, str) or not name:
        write_frame(
            {
                "id": rid,
                "ok": False,
                "error": {"code": ERROR_INVALID_ARGUMENT, "message": "缺少 method"},
            }
        )
        return

    try:
        result = dispatch(name, req.get("params"))
        write_frame({"id": rid, "ok": True, "result": result})
    except WorkerError as err:
        write_frame(
            {
                "id": rid,
                "ok": False,
                "error": {"code": err.code, "message": err.message, "detail": err.detail},
            }
        )
    except Exception as err:  # noqa: BLE001 —— 兜底所有未预期异常
        log(f"{name} 未预期异常: {err!r}")
        write_frame(
            {
                "id": rid,
                "ok": False,
                "error": {
                    "code": ERROR_INTERNAL,
                    "message": "内部错误，请查看日志",
                    "detail": error_detail(err),
                },
            }
        )


def main() -> int:
    _reconfigure_stdio()

    # 阶段 1：握手。主进程收到 ready 才认为可用，并据此校验协议版本
    write_frame(
        {
            "event": "worker.ready",
            "data": {
                "version": __version__,
                "protocol": PROTOCOL,
                "pid": os.getpid(),
                "python": sys.version.split()[0],
                "methods": registered_methods(),
            },
        }
    )
    log(f"启动完成 pid={os.getpid()} python={sys.version.split()[0]} methods={len(registered_methods())}")

    pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="ctext")
    try:
        while True:
            line = sys.stdin.readline()
            if not line:  # EOF：主进程退出或主动关闭了管道
                log("stdin 关闭，退出")
                break
            line = line.strip()
            if not line:
                continue

            try:
                req = json.loads(line)
            except json.JSONDecodeError as err:
                # 请求侧的坏帧无法应答（不知道 id），记日志后继续
                log(f"请求帧不是合法 JSON，已跳过: {err.msg}")
                continue

            pool.submit(_handle, req)
    except KeyboardInterrupt:
        log("收到 Ctrl-C，退出")
    finally:
        # 不取消排队任务，但在限定时间内等它们把响应写完
        pool.shutdown(wait=False)
        deadline = time.time() + DRAIN_GRACE_SECONDS
        with _idle:
            while _inflight > 0:
                remaining = deadline - time.time()
                if remaining <= 0:
                    log(f"仍有 {_inflight} 个请求未完成，超时退出")
                    break
                _idle.wait(remaining)

    return 0


if __name__ == "__main__":
    code = main()
    # 直接 _exit：线程池里可能还有阻塞中的线程，正常退出会被它们拖住
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
