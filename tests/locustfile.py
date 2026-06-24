# tests/locustfile.py
"""
Locust 压力测试脚本

使用方法：
    cd tests/
    locust -f locustfile.py --host=http://localhost:5000

    # 无头模式
    locust -f locustfile.py --headless -u 100 -r 10 --run-time 5m --host=http://localhost:5000

测试场景：
1. 健康检查 - 高频轻量请求
2. 登录认证 - 模拟用户登录
3. 连接管理 - CRUD 操作
4. 综合场景 - 多 API 混合压测
"""
import random
import time
from locust import HttpUser, task, between, events


class HealthCheckUser(HttpUser):
    """场景 1: 健康检查压测（低频，避免占满带宽）"""
    weight = 1
    wait_time = between(2, 5)

    @task
    def health_check(self):
        with self.client.get('/health', catch_response=True) as resp:
            if resp.status_code != 200:
                resp.failure(f'Health check failed: {resp.status_code}')
            else:
                data = resp.json()
                if data.get('status') != 'healthy':
                    resp.failure('Health check returned non-healthy status')


class AuthenticatedUser(HttpUser):
    """场景 2: 认证用户压测"""
    weight = 5
    wait_time = between(1, 3)

    def on_start(self):
        """登录获取 Token"""
        self.token = None
        resp = self.client.post('/api/login', json={
            'username': 'admin',
            'password': 'webshell2026',
        })
        if resp.status_code == 200:
            data = resp.json()
            self.token = data.get('token', '')
        self.headers = {}
        if self.token:
            self.headers['Authorization'] = f'Bearer {self.token}'

    @task(3)
    def get_me(self):
        if not self.token:
            return
        self.client.get('/api/me', headers=self.headers)

    @task(2)
    def list_connections(self):
        if not self.token:
            return
        self.client.get('/api/connections', headers=self.headers)

    @task(2)
    def health_auth(self):
        if not self.token:
            return
        self.client.get('/api/status', headers=self.headers)

    @task(1)
    def list_groups(self):
        if not self.token:
            return
        self.client.get('/api/groups', headers=self.headers)

    @task(1)
    def list_shortcuts(self):
        if not self.token:
            return
        self.client.get('/api/shortcuts', headers=self.headers)

    @task(1)
    def list_audit_logs(self):
        if not self.token:
            return
        self.client.get('/api/audit-logs', headers=self.headers)


class ConnectionCRUDUser(HttpUser):
    """场景 3: 连接 CRUD 压测"""
    weight = 2
    wait_time = between(2, 5)

    def on_start(self):
        """登录"""
        self.token = None
        resp = self.client.post('/api/login', json={
            'username': 'admin',
            'password': 'webshell2026',
        })
        if resp.status_code == 200:
            self.token = resp.json().get('token', '')
        self.headers = {}
        if self.token:
            self.headers['Authorization'] = f'Bearer {self.token}'
        self.created_ids = []

    def on_stop(self):
        """清理创建的连接"""
        if not self.token:
            return
        for cid in self.created_ids:
            try:
                self.client.delete(f'/api/connections/{cid}', headers=self.headers)
            except Exception:
                pass

    @task(3)
    def add_connection(self):
        if not self.token:
            return
        server_num = random.randint(1, 1000)
        resp = self.client.post('/api/connections', headers=self.headers, json={
            'host': f'192.168.{random.randint(1,255)}.{random.randint(1,255)}',
            'port': 22,
            'username': 'root',
            'password': f'test_password_{server_num}',
            'name': f'Server-{server_num}',
        })
        if resp.status_code in (200, 201):
            try:
                cid = resp.json().get('id')
                if cid:
                    self.created_ids.append(cid)
            except Exception:
                pass

    @task(1)
    def list_connections(self):
        if not self.token:
            return
        self.client.get('/api/connections', headers=self.headers)


class MixedScenarioUser(HttpUser):
    """场景 4: 混合场景压测"""
    weight = 4
    wait_time = between(0.5, 3)

    def on_start(self):
        """登录"""
        self.token = None
        resp = self.client.post('/api/login', json={
            'username': 'admin',
            'password': 'webshell2026',
        })
        if resp.status_code == 200:
            self.token = resp.json().get('token', '')
        self.headers = {}
        if self.token:
            self.headers['Authorization'] = f'Bearer {self.token}'

    @task(5)
    def health(self):
        self.client.get('/health')

    @task(3)
    def api_me(self):
        if not self.token:
            return
        self.client.get('/api/me', headers=self.headers)

    @task(2)
    def api_connections(self):
        if not self.token:
            return
        self.client.get('/api/connections', headers=self.headers)

    @task(2)
    def api_status(self):
        if not self.token:
            return
        self.client.get('/api/status', headers=self.headers)

    @task(1)
    def api_groups(self):
        if not self.token:
            return
        self.client.get('/api/groups', headers=self.headers)

    @task(1)
    def api_shortcuts(self):
        if not self.token:
            return
        self.client.get('/api/shortcuts', headers=self.headers)

    @task(1)
    def api_audit(self):
        if not self.token:
            return
        self.client.get('/api/audit-logs', headers=self.headers)

    @task(1)
    def api_alerts(self):
        if not self.token:
            return
        self.client.get('/api/alerts', headers=self.headers)


# ══════════════════════════════════════
#  事件回调
# ══════════════════════════════════════

@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    print('\n' + '=' * 60)
    print('  WebTerminal 压力测试开始')
    print(f'  目标: {environment.host}')
    print('  场景: 健康检查 + 认证 + CRUD + 混合')
    print('=' * 60 + '\n')


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    print('\n' + '=' * 60)
    print('  WebTerminal 压力测试结束')
    if environment.stats.total.fail_ratio > 0.01:
        print(f'  ⚠️  失败率: {environment.stats.total.fail_ratio * 100:.2f}%')
    else:
        print(f'  ✅ 失败率: {environment.stats.total.fail_ratio * 100:.2f}%')
    print('=' * 60 + '\n')
