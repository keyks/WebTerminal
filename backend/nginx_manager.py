"""
Nginx 生命周期管理 —— 由 app.py 直接管理启动/停止
"""
import os, sys, time, signal, atexit, subprocess
from pathlib import Path

# 🔧 修复 Windows 控制台中文乱码（config.py 已处理，此处兜底）
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        import io
        sys.stdout = io.TextIOWrapper(
            sys.stdout.buffer, encoding='utf-8', errors='replace', line_buffering=True
        )
        sys.stderr = io.TextIOWrapper(
            sys.stderr.buffer, encoding='utf-8', errors='replace', line_buffering=True
        )

_nginx_proc = None
_nginx_path = None

def start_nginx(nginx_path: str, port: int) -> bool:
    """启动 Nginx 并注册退出钩子"""
    global _nginx_proc, _nginx_path
    _nginx_path = nginx_path

    exe = Path(nginx_path) / 'nginx.exe'
    if not exe.exists():
        print(f"[Nginx] nginx.exe 不存在: {exe}")
        return False

    # 先尝试停止已有实例
    try:
        result = subprocess.run(
            [str(exe), '-p', nginx_path, '-s', 'stop'],
            capture_output=True, timeout=5
        )
        time.sleep(0.3)
    except Exception:
        pass

    # 启动 Nginx
    try:
        _nginx_proc = subprocess.Popen(
            [str(exe), '-p', nginx_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        )
        time.sleep(0.5)
        poll = _nginx_proc.poll()
        if poll is not None:
            print(f"[Nginx] 启动失败 (exit code: {poll})")
            return False
        print(f"[Nginx] 已启动 → http://localhost:{port}")
    except Exception as e:
        print(f"[Nginx] 启动异常: {e}")
        return False

    atexit.register(_stop_nginx)
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _signal_handler)
        except Exception:
            pass
    return True

def _stop_nginx():
    """停止 Nginx（atexit 回调）"""
    global _nginx_proc, _nginx_path
    if not _nginx_path:
        return
    exe = Path(_nginx_path) / 'nginx.exe'
    if not exe.exists():
        return
    try:
        subprocess.run(
            [str(exe), '-p', _nginx_path, '-s', 'quit'],
            capture_output=True, timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        )
        if _nginx_proc and _nginx_proc.poll() is None:
            _nginx_proc.wait(timeout=3)
        print("[Nginx] 已停止")
    except Exception:
        pass

def _signal_handler(signum, frame):
    """信号处理器 → 停止 Nginx → 退出"""
    _stop_nginx()
    sys.exit(0)
