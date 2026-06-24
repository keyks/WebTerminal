# tests/test_unit/test_config.py
"""
配置模块单元测试
验证全局配置的正确性，包括密钥生成、端口校验、安全策略等。
"""
import os
import pytest
from pathlib import Path
from cryptography.fernet import Fernet

# 注意：config 模块在导入时就会执行关键逻辑，所以必须在 conftest 设置好环境变量后再导入


class TestConfigBasics:
    """基础配置测试"""

    def test_data_dir_created(self):
        """CFG-001: DATA_DIR 路径被创建"""
        from config import config as cfg
        assert cfg.DATA_DIR.exists()
        assert cfg.DATA_DIR.is_dir()

    def test_secret_key_length(self):
        """CFG-002: SECRET_KEY 长度 >= 32"""
        from config import config as cfg
        assert len(cfg.SECRET_KEY) >= 32

    def test_encryption_key_valid(self):
        """CFG-003: ENCRYPTION_KEY 是有效 Fernet 密钥"""
        from config import config as cfg
        # 不会抛异常即为有效
        f = Fernet(cfg.ENCRYPTION_KEY)
        assert f is not None

    def test_jwt_key_length(self):
        """CFG-004: JWT_SECRET_KEY 长度 >= 32"""
        from config import config as cfg
        assert len(cfg.JWT_SECRET_KEY) >= 32

    def test_db_path_under_data_dir(self):
        """CFG-005: DB_PATH 在 DATA_DIR 下"""
        from config import config as cfg
        try:
            cfg.DB_PATH.relative_to(cfg.DATA_DIR)
        except ValueError:
            pytest.fail(f'DB_PATH ({cfg.DB_PATH}) 不在 DATA_DIR ({cfg.DATA_DIR}) 下')

    def test_recordings_dir_created(self):
        """CFG-006: RECORDINGS_DIR 被创建"""
        from config import config as cfg
        assert cfg.RECORDINGS_DIR.exists()

    def test_log_dir_created(self):
        """CFG-007: LOG_DIR 被创建"""
        from config import config as cfg
        assert cfg.LOG_DIR.exists()

    def test_default_admin_username(self):
        """CFG-008: 默认管理用户名为 admin"""
        from config import config as cfg
        assert cfg.ADMIN_USERNAME == 'admin'

    def test_admin_password_not_empty(self):
        """CFG-009: 管理员密码不为空"""
        from config import config as cfg
        assert len(cfg.ADMIN_PASSWORD) > 0

    def test_is_default_password_detection(self):
        """CFG-010: IS_DEFAULT_PASSWORD 检测"""
        from config import config as cfg
        # 我们在 conftest 中设置了 ADMIN_PASSWORD 环境变量
        # 所以 IS_DEFAULT_PASSWORD 应为 False
        if os.environ.get('ADMIN_PASSWORD', '').strip():
            assert cfg.IS_DEFAULT_PASSWORD is False
        else:
            assert cfg.IS_DEFAULT_PASSWORD is True

    def test_host_default(self):
        """CFG-011: 默认 HOST 为 0.0.0.0"""
        from config import config as cfg
        assert cfg.HOST == '0.0.0.0'

    def test_port_default(self):
        """CFG-012: PORT 为有效端口号"""
        from config import config as cfg
        assert 1 <= cfg.PORT <= 65535

    def test_debug_disabled_by_default(self):
        """CFG-013: 默认 DEBUG 为 False"""
        from config import config as cfg
        assert cfg.DEBUG is False


class TestPortValidation:
    """端口号校验测试"""

    def test_validate_port_valid(self):
        """CFG-020: 合法端口号（22, 80, 443, 65535）接受"""
        from app import _validate_port
        assert _validate_port(22) == 22
        assert _validate_port(80) == 80
        assert _validate_port(443) == 443
        assert _validate_port(65535) == 65535
        assert _validate_port("22") == 22  # 字符串也行

    def test_validate_port_invalid_zero(self):
        """CFG-021: 端口 0 返回默认值"""
        from app import _validate_port
        assert _validate_port(0) == 22
        assert _validate_port(0, default=8080) == 8080

    def test_validate_port_negative(self):
        """CFG-022: 负数端口返回默认值"""
        from app import _validate_port
        assert _validate_port(-1) == 22

    def test_validate_port_too_large(self):
        """CFG-023: 超范围端口返回默认值"""
        from app import _validate_port
        assert _validate_port(65536) == 22
        assert _validate_port(99999) == 22

    def test_validate_port_non_numeric(self):
        """CFG-024: 非数字端口返回默认值"""
        from app import _validate_port
        assert _validate_port("abc") == 22
        assert _validate_port(None) == 22


class TestConfigLimits:
    """配置限制和阈值测试"""

    def test_ssh_connect_timeout(self):
        from config import config as cfg
        assert cfg.SSH_CONNECT_TIMEOUT > 0

    def test_max_command_length(self):
        from config import config as cfg
        assert cfg.MAX_COMMAND_LENGTH > 0

    def test_max_terminal_output_bytes(self):
        from config import config as cfg
        assert cfg.MAX_TERMINAL_OUTPUT_BYTES > 0

    def test_max_edit_file_size(self):
        from config import config as cfg
        assert cfg.MAX_EDIT_FILE_SIZE > 0

    def test_max_upload_size(self):
        from config import config as cfg
        assert cfg.MAX_UPLOAD_SIZE > 0

    def test_max_sessions(self):
        from config import config as cfg
        assert cfg.MAX_SESSIONS > 0

    def test_login_max_attempts(self):
        from config import config as cfg
        assert cfg.LOGIN_MAX_ATTEMPTS > 0

    def test_login_lockout_secs(self):
        from config import config as cfg
        assert cfg.LOGIN_LOCKOUT_SECS > 0

    def test_jwt_expiry_hours(self):
        from config import config as cfg
        assert cfg.JWT_ACCESS_TOKEN_EXPIRES_HOURS > 0

    def test_allowed_origins_not_empty(self):
        from config import config as cfg
        assert len(cfg.ALLOWED_ORIGINS) > 0

    def test_allowed_origins_no_empty_string(self):
        """CFG-030: ALLOWED_ORIGINS 中无空字符串"""
        from config import config as cfg
        for origin in cfg.ALLOWED_ORIGINS:
            assert origin.strip() != '', f'发现空 origin 字符串'


class TestConfigProperties:
    """Config 类的 property 属性测试"""

    def test_admin_password_from_env(self):
        """ADMIN_PASSWORD 读取环境变量"""
        from config import config as cfg
        pwd = cfg.ADMIN_PASSWORD
        assert isinstance(pwd, str)
        assert len(pwd) > 0

    def test_admin_password_cached(self):
        """ADMIN_PASSWORD 被缓存（相同引用）"""
        from config import config as cfg
        pwd1 = cfg.ADMIN_PASSWORD
        pwd2 = cfg.ADMIN_PASSWORD
        assert pwd1 == pwd2  # 同一会话内密码不变


class TestEncryptionKeyManagement:
    """密钥管理测试"""

    def test_key_file_created(self):
        """密钥文件被创建"""
        from config import config as cfg
        key_file = cfg.DATA_DIR / '.encryption_key'
        assert key_file.exists()

    def test_secret_key_file_created(self):
        """SECRET_KEY 文件被创建"""
        from config import config as cfg
        key_file = cfg.DATA_DIR / '.secret_key'
        assert key_file.exists()

    def test_jwt_key_file_created(self):
        """JWT 密钥文件被创建"""
        from config import config as cfg
        key_file = cfg.DATA_DIR / '.jwt_key'
        assert key_file.exists()

    def test_key_file_permissions(self):
        """密钥文件权限检查（非 Windows 平台）"""
        if os.name == 'nt':
            pytest.skip('Windows 不检查文件权限 mode')
        from config import config as cfg
        key_file = cfg.DATA_DIR / '.encryption_key'
        mode = key_file.stat().st_mode & 0o777
        assert mode == 0o600, f'密钥文件权限应为 600，实际为 {oct(mode)}'
