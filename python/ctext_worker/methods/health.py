"""health.ping —— 主进程判断 worker 是否可用的唯一探针。

返回版本、pid、Python 版本、已注册方法与解析依赖是否就位。
主进程的「崩溃自恢复」验收就是靠 pid 变化来判定的。
"""

import importlib.util
import os
import sys
import time

from rpc import method, registered_methods
from version import PROTOCOL, __version__

# 进程启动时刻：uptime 用它算，避免反复读时钟带来的漂移
STARTED_AT = time.time()

# M1-04/M1-05 会用到的依赖，此处只探测是否可导入（find_spec 不真正加载）。
# pdfminer 已移除：D1 决策不做 PDF，省一份打包体积
# ebooklib 已移除（M1-05）：EPUB 改用标准库 zipfile + lxml，理由见 epub.py
PARSE_DEPS = ("lxml", "charset_normalizer", "PIL")


def _dep_available(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


@method("health.ping")
def ping(params: dict) -> dict:
    return {
        "version": __version__,
        "protocol": PROTOCOL,
        "pid": os.getpid(),
        "python": sys.version.split()[0],
        "uptimeMs": int((time.time() - STARTED_AT) * 1000),
        "methods": registered_methods(),
        "deps": {name: _dep_available(name) for name in PARSE_DEPS},
    }
