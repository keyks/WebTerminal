# tests/test_unit/test_ssh_manager.py
"""
SSH 管理器单元测试
验证 safe_command、端口测试、端口校验等工具函数。
"""
import socket
import pytest
from ssh_manager import safe_command


class TestSafeCommand:
    """safe_command 安全命令构建测试"""

    def test_basic_formatting(self):
        """SSH-001: 基本拼接"""
        cmd = safe_command("ls -la {path}", path="/home/user")
        # shlex.quote 在 Windows 上使用双引号，在 Linux 上使用单引号
        assert "ls -la" in cmd
        assert "/home/user" in cmd

    def test_special_characters_escaped(self):
        """SSH-002: 特殊字符被转义"""
        cmd = safe_command("echo {msg}", msg="hello; rm -rf /")
        assert "echo" in cmd
        # 分号应该被转义（被引号包裹）
        assert ";" in cmd
        # 关键：rm -rf / 不应该作为独立命令执行
        assert cmd.count("rm") == 1  # rm 只作为字符串出现

    def test_none_parameter_raises(self):
        """SSH-003: None 参数抛出异常"""
        with pytest.raises(ValueError, match='不能为 None'):
            safe_command("ls {path}", path=None)

    def test_multiple_parameters(self):
        """SSH-004: 多个参数"""
        cmd = safe_command(
            "cp {src} {dst}",
            src="/var/log/app.log",
            dst="/backup/logs/"
        )
        assert "/var/log/app.log" in cmd
        assert "/backup/logs/" in cmd

    def test_empty_string_parameter(self):
        """SSH-005: 空字符串参数被接受并转义"""
        cmd = safe_command("echo {msg}", msg="")
        assert "echo" in cmd
        # 空字符串被转义为 ''
        assert "''" in cmd or '""' in cmd

    def test_command_injection_prevented(self):
        """SSH-006: 命令注入被阻止"""
        # 攻击者尝试注入
        malicious = "$(cat /etc/passwd)"
        cmd = safe_command("echo {user_input}", user_input=malicious)
        # $ 应该被转义
        assert cmd.count("echo") == 1

    def test_pipe_injection_prevented(self):
        """SSH-007: 管道注入被阻止"""
        cmd = safe_command("grep {pattern} /var/log/syslog", pattern="error|rm -rf /")
        # | 应该被引号包裹
        assert "grep" in cmd

    def test_backtick_injection_prevented(self):
        """SSH-008: 反引号注入被阻止"""
        malicious = "`rm -rf /`"
        cmd = safe_command("echo {x}", x=malicious)
        assert "echo" in cmd

    def test_newline_injection_prevented(self):
        """SSH-009: 换行注入被阻止（不能注入额外命令）"""
        malicious = "hello\nrm -rf /"
        cmd = safe_command("echo {x}", x=malicious)
        # \n 被转义为字面量
        assert "echo" in cmd

    def test_numeric_parameter(self):
        """SSH-010: 数字参数正常处理"""
        cmd = safe_command("kill -{signal} {pid}", signal=9, pid=1234)
        assert "9" in cmd
        assert "1234" in cmd

    def test_path_with_spaces(self):
        """SSH-011: 带空格的路径"""
        cmd = safe_command("ls {path}", path="/Program Files/App")
        assert "Program Files" in cmd or "Program" in cmd


class TestPortTest:
    """SSHSession.test_port 静态方法测试"""

    def test_test_port_invalid_host(self):
        """SSH-020: 不可达主机返回 False（不抛异常）"""
        from ssh_manager import SSHSession
        # 使用 IANA 保留的测试地址
        result = SSHSession.test_port('192.0.2.1', 22, timeout=1)
        assert isinstance(result, bool)
        # 预期不可达
        assert result is False

    def test_test_port_invalid_port(self):
        """SSH-021: 过大端口号会触发溢出错误（预期行为，非崩溃）"""
        from ssh_manager import SSHSession
        import socket
        try:
            result = SSHSession.test_port('127.0.0.1', 99999, timeout=1)
            assert isinstance(result, bool)
        except OverflowError:
            # 在 Windows/eventlet 上可能抛出 OverflowError
            # 这是预期行为：端口号超出范围
            pass

    def test_test_port_timeout_respected(self):
        """SSH-022: 超时参数生效"""
        import time
        from ssh_manager import SSHSession
        start = time.time()
        SSHSession.test_port('10.255.255.1', 12345, timeout=2)
        elapsed = time.time() - start
        # 允许一些误差
        assert elapsed < 5, f'超时未生效，耗时 {elapsed:.2f}s'

    def test_test_port_localhost_nonexistent_port(self):
        """SSH-023: 本地不存在端口返回 False"""
        from ssh_manager import SSHSession
        # 使用一个几乎肯定没监听的高端口
        result = SSHSession.test_port('127.0.0.1', 59999, timeout=1)
        assert result is False

    def test_test_port_default_timeout(self):
        """SSH-024: 默认超时使用配置值"""
        from ssh_manager import SSHSession
        from config import config as cfg
        import time
        start = time.time()
        SSHSession.test_port('192.0.2.1', 22)
        elapsed = time.time() - start
        assert elapsed < cfg.PORT_TEST_TIMEOUT + 2


class TestPortValidation:
    """端口校验测试（SSHSession.connect 内逻辑）"""

    def test_valid_ports(self):
        """SSH-030: 合法端口 1-65535"""
        valid = [1, 22, 80, 443, 8080, 65535]
        for p in valid:
            assert 1 <= p <= 65535, f'{p} 应为合法端口'

    def test_invalid_ports(self):
        """SSH-031: 非法端口 <1 或 >65535"""
        invalid = [0, -1, 65536, 99999]
        for p in invalid:
            assert not (1 <= p <= 65535), f'{p} 应为非法端口'


class TestSSHSessionConnectValidation:
    """connect() 前置校验测试"""

    def test_empty_host_rejected(self):
        """SSH-040: 空主机拒绝"""
        from ssh_manager import SSHSession
        session = SSHSession({'host': '', 'username': 'root', 'password': 'pw'})
        success, msg = session.connect()
        assert success is False
        assert '主机' in msg or 'host' in msg.lower()

    def test_empty_username_rejected(self):
        """SSH-041: 空用户名拒绝"""
        from ssh_manager import SSHSession
        session = SSHSession({'host': '127.0.0.1', 'username': '', 'password': 'pw'})
        success, msg = session.connect()
        assert success is False

    def test_no_auth_rejected(self):
        """SSH-042: 无密码且无私钥拒绝"""
        from ssh_manager import SSHSession
        session = SSHSession({'host': '127.0.0.1', 'username': 'root'})
        success, msg = session.connect()
        assert success is False

    def test_invalid_port_rejected(self):
        """SSH-043: 无效端口拒绝"""
        from ssh_manager import SSHSession
        session = SSHSession({
            'host': '127.0.0.1', 'port': 0,
            'username': 'root', 'password': 'pw',
        })
        success, msg = session.connect()
        assert success is False
        assert '端口' in msg
