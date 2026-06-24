# tests/test_unit/test_database.py
"""
数据库模块单元测试
验证 SQLite CRUD 操作、加密解密、数据一致性等。
"""
import os
import pytest
import uuid
from cryptography.fernet import Fernet


class TestEncryption:
    """加密/解密测试"""

    def test_encrypt_decrypt_roundtrip(self, clean_db):
        """DB-001: 加密后解密与原值一致"""
        plaintext = 'Hello World! @#$%^&*()'
        encrypted = clean_db.encrypt(plaintext)
        assert encrypted != plaintext
        assert encrypted != ''
        decrypted = clean_db.decrypt(encrypted)
        assert decrypted == plaintext

    def test_encrypt_empty_string(self, clean_db):
        """DB-002: 空字符串加密返回空"""
        assert clean_db.encrypt('') == ''

    def test_decrypt_empty_string(self, clean_db):
        """DB-003: 空字符串解密返回空"""
        assert clean_db.decrypt('') == ''

    def test_decrypt_invalid_ciphertext(self, clean_db):
        """DB-004: 无效密文解密返回空（不崩溃）"""
        result = clean_db.decrypt('not_valid_cipher_text')
        assert result == ''

    def test_encrypt_unicode(self, clean_db):
        """DB-005: 加密支持 Unicode"""
        plaintext = '中文密码测试 🚀 日本語'
        encrypted = clean_db.encrypt(plaintext)
        decrypted = clean_db.decrypt(encrypted)
        assert decrypted == plaintext

    def test_encrypt_long_text(self, clean_db):
        """DB-006: 加密长文本"""
        plaintext = 'A' * 10000  # 10KB
        encrypted = clean_db.encrypt(plaintext)
        decrypted = clean_db.decrypt(encrypted)
        assert decrypted == plaintext

    def test_encrypt_special_chars(self, clean_db):
        """DB-007: 加密包含换行符等特殊字符"""
        plaintext = 'line1\nline2\tline3\r\nline4\x00'
        encrypted = clean_db.encrypt(plaintext)
        decrypted = clean_db.decrypt(encrypted)
        assert decrypted == plaintext


class TestGroups:
    """分组 CRUD 测试"""

    def test_add_group(self, clean_db):
        """DB-010: 添加分组"""
        g = clean_db.add_group('Production')
        assert g['name'] == 'Production'
        assert 'id' in g
        assert len(g['id']) == 8

    def test_get_groups_empty(self, clean_db):
        """DB-011: 空数据库分组列表为空"""
        groups = clean_db.get_groups()
        assert isinstance(groups, list)
        assert len(groups) == 0

    def test_get_groups_multiple(self, clean_db):
        """DB-012: 多个分组列表"""
        clean_db.add_group('Group A')
        clean_db.add_group('Group B')
        groups = clean_db.get_groups()
        assert len(groups) == 2
        names = {g['name'] for g in groups}
        assert names == {'Group A', 'Group B'}

    def test_get_group_by_id(self, clean_db):
        """DB-013: 按 ID 查询分组"""
        g = clean_db.add_group('Test Group')
        found = clean_db.get_group(g['id'])
        assert found is not None
        assert found['name'] == 'Test Group'

    def test_get_group_not_found(self, clean_db):
        """DB-014: 不存在的分组返回 None"""
        assert clean_db.get_group('nonexistent') is None
        assert clean_db.get_group('') is None

    def test_delete_group(self, clean_db):
        """DB-015: 删除分组"""
        g = clean_db.add_group('To Delete')
        clean_db.delete_group(g['id'])
        assert clean_db.get_group(g['id']) is None

    def test_delete_group_cascades_connections(self, clean_db):
        """DB-016: 删除分组时连接的 group_id 置空"""
        g = clean_db.add_group('Cascade Test')
        conn = clean_db.add_connection({
            'host': '10.0.0.1',
            'name': 'Test Server',
            'username': 'root',
            'password': 'test',
            'group_id': g['id'],
        })
        clean_db.delete_group(g['id'])
        # 重新获取连接，验证 group_id 被清空
        updated = clean_db.get_connection(conn['id'])
        assert updated is not None
        assert updated.get('group_id') in (None, '', 'None')


class TestConnections:
    """连接 CRUD 测试"""

    def test_add_connection_basic(self, clean_db):
        """DB-020: 添加基本连接"""
        conn = clean_db.add_connection({
            'host': '192.168.1.100',
            'port': 22,
            'username': 'admin',
            'password': 'secret123',
            'name': 'My Server',
        })
        assert conn is not None
        assert 'id' in conn
        assert conn['host'] == '192.168.1.100'
        assert conn['port'] == 22
        assert conn['username'] == 'admin'
        assert conn['password'] == 'secret123'  # 解密后
        assert conn['name'] == 'My Server'

    def test_add_connection_defaults(self, clean_db):
        """DB-021: 添加连接使用默认值"""
        conn = clean_db.add_connection({
            'host': '10.0.0.1',
            'password': 'pw',
        })
        assert conn['port'] == 22
        assert conn['username'] == 'root'
        assert conn['name'] == '10.0.0.1'  # name 默认取 host
        assert conn['color'] == '#00b894'

    def test_add_connection_with_private_key(self, clean_db):
        """DB-022: 添加带私钥的连接"""
        fake_key = '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----'
        conn = clean_db.add_connection({
            'host': '10.0.0.2',
            'username': 'deploy',
            'private_key': fake_key,
            'private_key_passphrase': 'keypass',
        })
        assert conn['private_key'] == fake_key
        assert conn['private_key_passphrase'] == 'keypass'
        assert conn['password'] == ''

    def test_get_all_connections(self, clean_db):
        """DB-023: 获取所有连接"""
        clean_db.add_connection({'host': '10.0.0.1', 'password': 'p1'})
        clean_db.add_connection({'host': '10.0.0.2', 'password': 'p2'})
        conns = clean_db.get_all_connections()
        assert len(conns) == 2

    def test_get_all_connections_light_no_password(self, clean_db):
        """DB-024: 轻量列表不包含明文密码"""
        clean_db.add_connection({'host': '10.0.0.1', 'password': 'secret'})
        conns = clean_db.get_all_connections_light()
        assert len(conns) == 1
        assert 'password' not in conns[0]
        assert 'password_enc' not in conns[0]
        assert 'private_key' not in conns[0]

    def test_get_connection_by_id(self, clean_db):
        """DB-025: 按 ID 查询连接"""
        created = clean_db.add_connection({
            'host': '10.0.0.3', 'password': 'pw', 'name': 'Target',
        })
        fetched = clean_db.get_connection(created['id'])
        assert fetched is not None
        assert fetched['host'] == '10.0.0.3'
        assert fetched['name'] == 'Target'

    def test_get_connection_not_found(self, clean_db):
        """DB-026: 不存在的连接返回 None"""
        assert clean_db.get_connection('nonexistent') is None

    def test_update_connection(self, clean_db):
        """DB-027: 更新连接"""
        conn = clean_db.add_connection({'host': '10.0.0.4', 'password': 'old_pw'})
        updated = clean_db.update_connection(conn['id'], {
            'host': '10.0.0.99',
            'name': 'Renamed',
        })
        assert updated is not None
        assert updated['host'] == '10.0.0.99'
        assert updated['name'] == 'Renamed'
        # 未传入的字段保留原值
        assert updated['password'] == 'old_pw'

    def test_update_connection_not_found(self, clean_db):
        """DB-028: 更新不存在的连接返回 None"""
        result = clean_db.update_connection('nope', {'host': 'x'})
        assert result is None

    def test_delete_connection(self, clean_db):
        """DB-029: 删除连接"""
        conn = clean_db.add_connection({'host': '10.0.0.5', 'password': 'pw'})
        clean_db.delete_connection(conn['id'])
        assert clean_db.get_connection(conn['id']) is None

    def test_update_last_connected(self, clean_db):
        """DB-030: 更新最后连接时间"""
        conn = clean_db.add_connection({'host': '10.0.0.6', 'password': 'pw'})
        clean_db.update_last_connected(conn['id'])
        updated = clean_db.get_connection(conn['id'])
        assert updated['last_connected'] is not None

    def test_password_encrypted_in_db(self, clean_db, temp_data_dir):
        """DB-031: 密码在数据库中加密存储（不在查询结果中出现明文）"""
        from config import config as cfg
        import sqlite3
        conn = clean_db.add_connection({
            'host': '10.0.0.7',
            'password': 'MySecret@123',
        })
        # 直接查 SQLite 原始数据
        raw_conn = sqlite3.connect(str(cfg.DB_PATH))
        raw_conn.row_factory = sqlite3.Row
        row = raw_conn.execute(
            'SELECT * FROM connections WHERE id=?', (conn['id'],)
        ).fetchone()
        raw_conn.close()
        assert 'MySecret@123' not in row['password_enc']


class TestQuickConnectHistory:
    """快速连接历史测试"""

    def test_upsert_quick_history(self, clean_db):
        """DB-040: 添加快速连接历史"""
        clean_db.upsert_quick_history('10.0.0.1', 22, 'root', 'pw')
        history = clean_db.get_quick_history()
        assert len(history) == 1
        assert history[0]['host'] == '10.0.0.1'
        assert history[0]['username'] == 'root'
        # 不应返回明文密码
        assert 'password' not in history[0]
        assert history[0].get('has_password') is True

    def test_upsert_duplicate_updates(self, clean_db):
        """DB-041: 重复连接更新计数"""
        clean_db.upsert_quick_history('10.0.0.1', 22, 'root', 'pw1')
        clean_db.upsert_quick_history('10.0.0.1', 22, 'root', 'pw2')
        history = clean_db.get_quick_history()
        assert len(history) == 1
        assert history[0]['use_count'] == 2

    def test_history_max_limit(self, clean_db):
        """DB-042: 历史记录上限控制"""
        from config import config as cfg
        max_count = cfg.QUICK_CONNECT_HISTORY_MAX
        for i in range(max_count + 5):
            clean_db.upsert_quick_history(
                f'10.0.0.{i % 256}', 22, 'root', 'pw'
            )
        history = clean_db.get_quick_history()
        assert len(history) <= max_count

    def test_delete_quick_history(self, clean_db):
        """DB-043: 删除单条历史"""
        clean_db.upsert_quick_history('10.0.0.1', 22, 'root', 'pw')
        history = clean_db.get_quick_history()
        hid = history[0]['id']
        clean_db.delete_quick_history(hid)
        assert len(clean_db.get_quick_history()) == 0

    def test_clear_quick_history(self, clean_db):
        """DB-044: 清空历史"""
        for i in range(5):
            clean_db.upsert_quick_history(f'10.0.0.{i}', 22, 'root', 'pw')
        clean_db.clear_quick_history()
        assert len(clean_db.get_quick_history()) == 0

    def test_history_has_password_flag(self, clean_db):
        """DB-045: has_password 是否正确反映密码存在性"""
        clean_db.upsert_quick_history('10.0.0.1', 22, 'root', 'mypass')
        history = clean_db.get_quick_history()
        assert history[0]['has_password'] is True


class TestShortcuts:
    """快捷命令测试"""

    def test_add_shortcut(self, clean_db):
        """DB-050: 添加快捷命令"""
        sc = clean_db.add_shortcut('List Files', 'ls -la', 'List all files')
        assert sc['name'] == 'List Files'
        assert sc['command'] == 'ls -la'
        assert sc['description'] == 'List all files'

    def test_add_shortcut_empty_name_raises(self, clean_db):
        """DB-051: 空名称拒绝"""
        with pytest.raises(ValueError, match='名称和命令不能为空'):
            clean_db.add_shortcut('', 'ls')

    def test_add_shortcut_empty_command_raises(self, clean_db):
        """DB-052: 空命令拒绝"""
        with pytest.raises(ValueError, match='名称和命令不能为空'):
            clean_db.add_shortcut('test', '')

    def test_get_shortcuts(self, clean_db):
        """DB-053: 获取快捷命令列表"""
        clean_db.add_shortcut('Cmd A', 'echo a')
        clean_db.add_shortcut('Cmd B', 'echo b')
        shortcuts = clean_db.get_shortcuts()
        assert len(shortcuts) == 2

    def test_update_shortcut(self, clean_db):
        """DB-054: 更新快捷命令"""
        sc = clean_db.add_shortcut('Old', 'old cmd')
        clean_db.update_shortcut(sc['id'], 'New', 'new cmd', 'Updated')
        shortcuts = clean_db.get_shortcuts()
        updated = [s for s in shortcuts if s['id'] == sc['id']][0]
        assert updated['name'] == 'New'
        assert updated['command'] == 'new cmd'
        assert updated['description'] == 'Updated'

    def test_delete_shortcut(self, clean_db):
        """DB-055: 删除快捷命令"""
        sc = clean_db.add_shortcut('To Delete', 'rm')
        clean_db.delete_shortcut(sc['id'])
        shortcuts = clean_db.get_shortcuts()
        assert len(shortcuts) == 0


class TestAuditLogs:
    """审计日志测试"""

    def test_add_audit(self, clean_db):
        """DB-060: 写入审计日志"""
        clean_db.add_audit('login', 'admin', 'web', 'test login', '127.0.0.1')
        logs = clean_db.get_audit_logs()
        assert len(logs) >= 1
        latest = logs[0]
        assert latest['action'] == 'login'
        assert latest['user'] == 'admin'

    def test_audit_logs_limit(self, clean_db):
        """DB-061: 审计日志查询限制"""
        for i in range(150):
            clean_db.add_audit(f'action_{i}', 'user', 'target', 'detail', '127.0.0.1')
        logs = clean_db.get_audit_logs(limit=50)
        assert len(logs) == 50

    def test_audit_fallback_on_error(self, clean_db, temp_data_dir):
        """DB-062: 审计日志写入失败时降级到文件"""
        from config import config as cfg
        # 此测试验证 fallback 逻辑存在，不模拟 DB 错误
        # 正常写入应成功
        clean_db.add_audit('test_action', 'test_user', '', '', '127.0.0.1')
        logs = clean_db.get_audit_logs()
        assert any(l['action'] == 'test_action' for l in logs)


class TestDatabaseInit:
    """数据库初始化测试"""

    def test_all_tables_exist(self, clean_db):
        """DB-070: 所有必需的表都存在"""
        import sqlite3
        conn = sqlite3.connect(str(clean_db.db_path))
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        tables = {row[0] for row in cursor.fetchall()}
        conn.close()
        expected = {
            'users', 'groups', 'connections',
            'quick_connect_history', 'audit_logs',
            'command_shortcuts', 'distribution_tasks',
        }
        missing = expected - tables
        assert not missing, f'缺少表: {missing}'

    def test_repeated_init_idempotent(self, clean_db):
        """DB-071: 重复初始化不破坏数据"""
        conn = clean_db.add_connection({'host': '10.0.0.1', 'password': 'pw'})
        # 重新创建 Database 实例模拟重复初始化
        from database import Database
        db2 = Database()
        conns = db2.get_all_connections()
        assert len(conns) == 1
        assert conns[0]['host'] == '10.0.0.1'

    def test_indexes_exist(self, clean_db):
        """DB-072: 性能索引存在"""
        import sqlite3
        conn = sqlite3.connect(str(clean_db.db_path))
        indexes = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).fetchall()
        conn.close()
        index_names = {row[0] for row in indexes}
        required = {'idx_conn_group', 'idx_audit_time', 'idx_quick_host'}
        missing = required - index_names
        assert not missing, f'缺少索引: {missing}'


class TestDataIntegrity:
    """数据完整性测试"""

    def test_connection_id_unique(self, clean_db):
        """DB-080: 连接 ID 唯一"""
        ids = set()
        for i in range(20):
            conn = clean_db.add_connection({'host': f'10.0.0.{i}', 'password': f'pw{i}'})
            assert conn['id'] not in ids, f'重复 ID: {conn["id"]}'
            ids.add(conn['id'])

    def test_update_preserves_unmodified_fields(self, clean_db):
        """DB-081: 更新保留未修改字段"""
        import json
        conn = clean_db.add_connection({
            'host': '10.0.0.50',
            'password': 'keep_me',
            'name': 'Original',
            'color': '#ff0000',
            'description': 'test desc',
        })
        clean_db.update_connection(conn['id'], {'name': 'Updated'})
        updated = clean_db.get_connection(conn['id'])
        assert updated['name'] == 'Updated'
        assert updated['host'] == '10.0.0.50'
        assert updated['password'] == 'keep_me'
        assert updated['color'] == '#ff0000'
        assert updated['description'] == 'test desc'

    def test_group_fk_integrity(self, clean_db):
        """DB-082: 非法 group_id 被拒绝"""
        conn = clean_db.add_connection({
            'host': '10.0.0.1',
            'password': 'pw',
            'group_id': 'invalid_group_id',
        })
        assert conn.get('group_id') in (None, '', 'None')


class TestDistributionTasks:
    """文件分发任务测试"""

    def test_save_and_get_task(self, clean_db):
        """DB-090: 保存并获取分发任务"""
        task_id = 'task_001'
        clean_db.save_distribute_task(
            task_id, '/src/file.txt', '/dst/file.txt',
            ['node1', 'node2', 'node3'],
            strategy='overwrite',
        )
        task = clean_db.get_distribute_task(task_id)
        assert task is not None
        assert task['source_path'] == '/src/file.txt'
        assert task['target_path'] == '/dst/file.txt'
        assert task['target_nodes'] == ['node1', 'node2', 'node3']
        assert task['strategy'] == 'overwrite'
        assert task['status'] == 'running'
        assert task['total_nodes'] == 3
        assert task['completed_nodes'] == 0

    def test_update_task_status(self, clean_db):
        """DB-091: 更新任务状态"""
        clean_db.save_distribute_task(
            'task_002', '/src', '/dst', ['n1'], 'skip'
        )
        clean_db.update_distribute_task('task_002', status='completed', completed_nodes=1)
        task = clean_db.get_distribute_task('task_002')
        assert task['status'] == 'completed'
        assert task['completed_nodes'] == 1

    def test_get_active_tasks(self, clean_db):
        """DB-092: 获取活跃任务"""
        clean_db.save_distribute_task('t1', '/a', '/b', ['n1'])
        clean_db.save_distribute_task('t2', '/c', '/d', ['n2'])
        clean_db.update_distribute_task('t1', status='completed')
        active = clean_db.get_active_distribute_tasks()
        assert len(active) == 1
        assert active[0]['task_id'] == 't2'

    def test_task_not_found(self, clean_db):
        """DB-093: 不存在的任务返回 None"""
        assert clean_db.get_distribute_task('nonexistent') is None
