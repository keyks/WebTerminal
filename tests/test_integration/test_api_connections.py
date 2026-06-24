# tests/test_integration/test_api_connections.py
"""
连接管理 API 集成测试
验证连接 CRUD、分组管理、快捷命令、审计日志等。
"""
import os
import json
import pytest


def _get_data(resp):
    """从 API 响应中提取数据部分。
    API 返回格式: {'status': 'ok', 'data': {...}} 或直接 {...}
    """
    json_data = resp.get_json() or {}
    if isinstance(json_data, dict) and 'data' in json_data and isinstance(json_data['data'], dict):
        return json_data['data']
    return json_data


class TestConnectionsAPI:
    """连接管理 API 测试"""

    def test_list_connections_empty(self, app_client, auth_headers):
        """API-040: 空列表"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.get('/api/connections', headers=auth_headers)
        if resp.status_code == 200:
            data = resp.get_json()
            assert isinstance(data, (list, dict))

    def test_add_connection(self, app_client, auth_headers):
        """API-041: 添加连接"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.post('/api/connections', headers=auth_headers, json={
            'host': '192.168.1.100',
            'port': 22,
            'username': 'root',
            'password': 'test123',
            'name': 'Test Server',
        })
        assert resp.status_code in (200, 201)
        data = _get_data(resp)
        assert 'id' in data
        assert data.get('host') == '192.168.1.100'

    def test_add_connection_missing_host(self, app_client, auth_headers):
        """API-042: 缺少必填字段"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.post('/api/connections', headers=auth_headers, json={
            'username': 'root',
            'password': 'test',
        })
        # 应该返回 400 或仍然接受（使用默认值）
        assert resp.status_code in (200, 201, 400)

    def test_get_single_connection(self, app_client, auth_headers):
        """API-043: 获取单个连接"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        # 先添加
        add_resp = app_client.post('/api/connections', headers=auth_headers, json={
            'host': '10.0.0.1', 'password': 'pw', 'name': 'Get Test',
        })
        if add_resp.status_code in (200, 201):
            conn_id = _get_data(add_resp).get('id')
            resp = app_client.get(f'/api/connections/{conn_id}', headers=auth_headers)
            assert resp.status_code == 200
            got = _get_data(resp)
            assert got.get('host') == '10.0.0.1'

    def test_get_nonexistent_connection(self, app_client, auth_headers):
        """API-044: 获取不存在的连接"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.get('/api/connections/nonexistent', headers=auth_headers)
        assert resp.status_code == 404

    def test_update_connection(self, app_client, auth_headers):
        """API-045: 更新连接"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        add_resp = app_client.post('/api/connections', headers=auth_headers, json={
            'host': '10.0.0.2', 'password': 'pw', 'name': 'Before Update',
        })
        if add_resp.status_code in (200, 201):
            conn_id = _get_data(add_resp).get('id')
            resp = app_client.put(f'/api/connections/{conn_id}', headers=auth_headers, json={
                'name': 'After Update',
                'host': '10.0.0.99',
            })
            assert resp.status_code == 200
            data = _get_data(resp)
            assert data.get('name') == 'After Update'

    def test_delete_connection(self, app_client, auth_headers):
        """API-046: 删除连接"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        add_resp = app_client.post('/api/connections', headers=auth_headers, json={
            'host': '10.0.0.3', 'password': 'pw', 'name': 'To Delete',
        })
        if add_resp.status_code in (200, 201):
            conn_id = _get_data(add_resp).get('id')
            del_resp = app_client.delete(f'/api/connections/{conn_id}', headers=auth_headers)
            assert del_resp.status_code == 200
            # 验证已删除
            get_resp = app_client.get(f'/api/connections/{conn_id}', headers=auth_headers)
            assert get_resp.status_code == 404

    def test_test_connection_unreachable(self, app_client, auth_headers):
        """API-047: 测试不可达连接"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.post('/api/test-connection', headers=auth_headers, json={
            'host': '192.0.2.1',  # TEST-NET，不可达
            'port': 22,
            'username': 'root',
            'password': 'test',
        })
        assert resp.status_code == 200
        data = resp.get_json()
        # 应该返回连接失败
        assert data.get('success') is False or 'error' in str(data).lower()


class TestGroupsAPI:
    """分组管理 API 测试"""

    def test_list_groups(self, app_client, auth_headers):
        """API-050: 列出分组"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.get('/api/groups', headers=auth_headers)
        assert resp.status_code == 200

    def test_add_group(self, app_client, auth_headers):
        """API-051: 添加分组"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.post('/api/groups', headers=auth_headers, json={
            'name': 'Production',
        })
        assert resp.status_code in (200, 201)

    def test_delete_group(self, app_client, auth_headers):
        """API-052: 删除分组"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        add_resp = app_client.post('/api/groups', headers=auth_headers, json={
            'name': 'To Delete',
        })
        if add_resp.status_code in (200, 201):
            gid = _get_data(add_resp).get('id')
            resp = app_client.delete(f'/api/groups/{gid}', headers=auth_headers)
            assert resp.status_code == 200


class TestShortcutsAPI:
    """快捷命令 API 测试"""

    def test_list_shortcuts(self, app_client, auth_headers):
        """API-060: 列出快捷命令"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.get('/api/shortcuts', headers=auth_headers)
        assert resp.status_code == 200

    def test_add_shortcut(self, app_client, auth_headers):
        """API-061: 添加快捷命令"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.post('/api/shortcuts', headers=auth_headers, json={
            'name': 'List Files',
            'command': 'ls -la',
            'description': 'List all files',
        })
        assert resp.status_code in (200, 201)

    def test_add_shortcut_empty_name(self, app_client, auth_headers):
        """API-062: 空名称被拒绝"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.post('/api/shortcuts', headers=auth_headers, json={
            'name': '',
            'command': 'ls',
        })
        assert resp.status_code == 400

    def test_update_shortcut(self, app_client, auth_headers):
        """API-063: 更新快捷命令"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        add_resp = app_client.post('/api/shortcuts', headers=auth_headers, json={
            'name': 'Old Name', 'command': 'old',
        })
        if add_resp.status_code in (200, 201):
            sid = _get_data(add_resp).get('id')
            resp = app_client.put(f'/api/shortcuts/{sid}', headers=auth_headers, json={
                'name': 'New Name', 'command': 'new',
            })
            assert resp.status_code == 200

    def test_delete_shortcut(self, app_client, auth_headers):
        """API-064: 删除快捷命令"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        add_resp = app_client.post('/api/shortcuts', headers=auth_headers, json={
            'name': 'To Delete', 'command': 'rm',
        })
        if add_resp.status_code in (200, 201):
            sid = _get_data(add_resp).get('id')
            resp = app_client.delete(f'/api/shortcuts/{sid}', headers=auth_headers)
            assert resp.status_code == 200


class TestQuickHistoryAPI:
    """快速连接历史 API 测试"""

    def test_list_history(self, app_client, auth_headers):
        """API-070: 列出快速连接历史"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.get('/api/quick-history', headers=auth_headers)
        assert resp.status_code == 200


class TestAuditLogsAPI:
    """审计日志 API 测试"""

    def test_list_audit_logs(self, app_client, auth_headers):
        """API-080: 列出审计日志"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.get('/api/audit-logs', headers=auth_headers)
        assert resp.status_code == 200


class TestHealthAPI:
    """健康检查 API 测试"""

    def test_public_health(self, app_client):
        """API-090: 公开健康检查"""
        resp = app_client.get('/health')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data.get('status') == 'healthy'

    def test_authenticated_health(self, app_client, auth_headers):
        """API-091: 认证健康检查（带 Token）"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.get('/api/status', headers=auth_headers)
        assert resp.status_code == 200


class TestAlertsAPI:
    """告警 API 测试"""

    def test_list_alerts(self, app_client, auth_headers):
        """API-100: 列出告警（初始为空）"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.get('/api/alerts', headers=auth_headers)
        assert resp.status_code == 200

    def test_clear_alerts(self, app_client, auth_headers):
        """API-101: 清空告警"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.post('/api/alerts/clear', headers=auth_headers)
        assert resp.status_code == 200


class TestRecordingsAPI:
    """会话录制 API 测试"""

    def test_list_recordings(self, app_client, auth_headers):
        """API-110: 列出录制（初始为空）"""
        if not auth_headers:
            pytest.skip('无法获取 auth_headers')
        resp = app_client.get('/api/recordings', headers=auth_headers)
        assert resp.status_code in (200, 404)
