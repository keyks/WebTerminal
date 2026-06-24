"""
会话录制与回放
"""
import json
import time
from datetime import datetime
from pathlib import Path
from config import config
from logger import log


class SessionRecorder:
    """录制终端会话"""

    def __init__(self, session_id: str, conn_name: str = ''):
        self.session_id = session_id
        self.conn_name = conn_name
        self.recording: list = []
        self.start_time: float = time.time()
        self.enabled: bool = config.ENABLE_RECORDING
        self.output_path: Path | None = None

        if self.enabled:
            ts = datetime.now().strftime('%Y%m%d_%H%M%S')
            safe_name = "".join(c for c in conn_name if c.isalnum() or c in '-_.')
            self.output_path = config.RECORDINGS_DIR / f"{ts}_{safe_name}_{session_id[:8]}.json"
            log.info(f"[Recorder] 开始录制: {self.output_path}")

    def record_output(self, data: str):
        if not self.enabled:
            return
        self.recording.append({
            'type': 'output',
            't': round(time.time() - self.start_time, 3),
            'd': data
        })

    def record_input(self, data: str):
        if not self.enabled:
            return
        self.recording.append({
            'type': 'input',
            't': round(time.time() - self.start_time, 3),
            'd': data
        })

    def save(self):
        if not self.enabled or not self.recording or not self.output_path:
            return
        try:
            payload = {
                'session_id': self.session_id,
                'conn_name': self.conn_name,
                'start': datetime.fromtimestamp(self.start_time).isoformat(),
                'duration': round(time.time() - self.start_time, 1),
                'events': self.recording
            }
            self.output_path.write_text(
                json.dumps(payload, ensure_ascii=False), encoding='utf-8'
            )
            log.info(f"[Recorder] 录制已保存: {self.output_path} ({len(self.recording)} 事件)")
        except Exception as e:
            log.error(f"[Recorder] 保存失败: {e}")


def list_recordings() -> list:
    """列出所有录制文件"""
    result = []
    try:
        for f in sorted(config.RECORDINGS_DIR.glob('*.json'), reverse=True):
            try:
                meta = json.loads(f.read_text(encoding='utf-8'))
                result.append({
                    'filename': f.name,
                    'session_id': meta.get('session_id', ''),
                    'conn_name': meta.get('conn_name', ''),
                    'start': meta.get('start', ''),
                    'duration': meta.get('duration', 0),
                    'events': len(meta.get('events', []))
                })
            except Exception:
                pass
    except Exception:
        pass
    return result


def load_recording(filename: str) -> dict | None:
    """加载录制文件"""
    try:
        safe = Path(filename).name
        path = config.RECORDINGS_DIR / safe
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return None