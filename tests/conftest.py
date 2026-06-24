# tests/conftest.py
"""
pytest 全局 fixtures 和配置
"""
import os
import sys
import tempfile
import shutil
from pathlib import Path

import pytest

# 确保 backend 在 sys.path 中
BACKEND_DIR = Path(__file__).parent.parent / 'backend'
sys.path.insert(0, str(BACKEND_DIR))

# ══════════════════════════════════════
#  测试环境变量预设（在任何模块导入前设置）
# ══════════════════════════════════════

os.environ.setdefault('DATA_DIR', str(Path(tempfile.gettempdir()) / 'webterminal_test'))
os.environ.setdefault('SECRET_KEY', 'test-secret-key-' + 'x' * 16)
os.environ.setdefault('JWT_SECRET_KEY', 'test-jwt-secret-' + 'x' * 16)
os.environ.setdefault('ADMIN_PASSWORD', 'test_admin_pass_123')
os.environ.setdefault('AI_ENABLED', 'false')
os.environ.setdefault('ENABLE_RECORDING', 'false')
os.environ.setdefault('DEBUG', 'false')
os.environ.setdefault('SSH_CONNECT_TIMEOUT', '5')
os.environ.setdefault('PORT_TEST_TIMEOUT', '2')
os.environ.setdefault('LOGIN_MAX_ATTEMPTS', '3')
os.environ.setdefault('LOGIN_LOCKOUT_SECS', '30')


@pytest.fixture(scope='session')
def temp_data_dir():
    """创建临时 DATA_DIR，测试结束后清理"""
    tmp = tempfile.mkdtemp(prefix='wt_test_')
    old_data_dir = os.environ.get('DATA_DIR')
    os.environ['DATA_DIR'] = tmp
    yield Path(tmp)
    # 恢复旧值
    if old_data_dir:
        os.environ['DATA_DIR'] = old_data_dir
    # 清理临时目录
    try:
        shutil.rmtree(tmp, ignore_errors=True)
    except Exception:
        pass


@pytest.fixture
def clean_db(temp_data_dir):
    """
    每个测试用例使用独立的干净数据库。
    通过删除 SQLite 文件实现隔离。
    """
    # 首次导入会创建数据库
    from config import config as cfg

    db_path = cfg.DB_PATH
    # 删除已有数据库文件（确保干净状态）
    if db_path.exists():
        db_path.unlink()
    # 删除 WAL/SHM 文件
    for suffix in ['-wal', '-shm']:
        p = db_path.with_name(db_path.name + suffix)
        if p.exists():
            p.unlink()

    # 重新初始化数据库实例
    from database import Database
    db = Database()
    yield db

    # 清理
    try:
        if db_path.exists():
            db_path.unlink()
    except Exception:
        pass


@pytest.fixture
def app_client(temp_data_dir, clean_db):
    """创建 Flask 测试客户端"""
    from app import app, _login_attempts, _login_lock

    # 清除速率限制状态（避免跨测试影响）
    with _login_lock:
        _login_attempts.clear()

    app.config['TESTING'] = True
    app.config['SERVER_NAME'] = 'localhost'
    with app.test_client() as client:
        yield client


@pytest.fixture
def auth_headers(app_client):
    """获取已认证的请求头"""
    resp = app_client.post('/api/login', json={
        'username': 'admin',
        'password': os.environ.get('ADMIN_PASSWORD', 'test_admin_pass_123'),
    })
    if resp.status_code == 200:
        token = resp.get_json().get('token', '')
        return {'Authorization': f'Bearer {token}'}
    return {}
