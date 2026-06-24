# backend/alert_engine.py
"""
监控告警引擎
"""
import threading
import time
import uuid
from typing import Dict, List, Optional, Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from logger import log
from ssh_manager import safe_command


class AlertSeverity(Enum):
    INFO     = 'info'
    WARNING  = 'warning'
    CRITICAL = 'critical'


@dataclass
class AlertRule:
    id:           str
    name:         str
    type:         str
    node_ids:     List[str]
    threshold:    float
    severity:     AlertSeverity = AlertSeverity.WARNING
    enabled:      bool = True
    cooldown:     int = 300
    process_name: Optional[str] = None


@dataclass
class Alert:
    id:           str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    rule_id:      str = ''
    node_id:      str = ''
    host:         str = ''
    message:      str = ''
    value:        float = 0.0
    severity:     AlertSeverity = AlertSeverity.WARNING
    created_at:   str = field(default_factory=lambda: datetime.now().isoformat())
    acknowledged: bool = False


class AlertEngine:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        self._rules:      Dict[str, AlertRule] = {}
        self._alerts:     List[Alert]          = []
        self._last_alert: Dict[str, float]     = {}
        self._running     = False
        self._lock        = threading.Lock()
        self._callbacks:  List[Callable]       = []

    def add_rule(self, rule: AlertRule):
        with self._lock:
            self._rules[rule.id] = rule

    def remove_rule(self, rule_id: str):
        with self._lock:
            self._rules.pop(rule_id, None)

    def get_rules(self) -> List[AlertRule]:
        with self._lock:
            return list(self._rules.values())

    def on_alert(self, callback: Callable):
        self._callbacks.append(callback)

    def start(self):
        if self._running:
            return
        self._running = True
        threading.Thread(
            target=self._run, daemon=True, name='AlertEngine'
        ).start()
        log.info('[AlertEngine] 已启动')

    def stop(self):
        self._running = False

    def _run(self):
        while self._running:
            try:
                self._check_all_rules()
            except Exception as e:
                log.error(f'[AlertEngine] 检查失败: {e}')
            finally:
                time.sleep(30)

    def _check_all_rules(self):
        with self._lock:
            rules = list(self._rules.values())
        for rule in rules:
            if not rule.enabled:
                continue
            try:
                self._check_rule(rule)
            except Exception as e:
                log.error(f'[AlertEngine] 规则 {rule.id} 异常: {e}')

    def _check_rule(self, rule: AlertRule):
        # 延迟导入避免循环依赖
        from core import db, ssh_manager

        if rule.node_ids:
            nodes = []
            for nid in rule.node_ids:
                conn = db.get_connection(nid)
                if conn:
                    nodes.append({
                        'id': nid,
                        'host': conn.get('host', ''),
                        'conn': conn
                    })
        else:
            nodes = [
                {'id': c['id'], 'host': c.get('host', ''), 'conn': c}
                for c in db.get_all_connections()
            ]

        for node in nodes:
            value = self._get_metric_value(rule, node, ssh_manager)
            if value is None:
                continue
            if self._is_triggered(rule, value):
                self._trigger_alert(rule, node, value)

    def _get_metric_value(self, rule: AlertRule, node: dict,
                          ssh_manager) -> Optional[float]:
        session_id = f"alert_{uuid.uuid4().hex[:8]}"
        conn = node['conn']

        success, _ = ssh_manager.create_session(
            session_id, conn, f"alert-{node['host']}"
        )
        if not success:
            return None

        session = ssh_manager.get_session(session_id)
        try:
            if rule.type == 'cpu':
                return session.get_system_info().get('cpu_percent')
            elif rule.type == 'memory':
                return session.get_system_info().get('memory', {}).get('percent')
            elif rule.type == 'disk':
                return session.get_system_info().get('disk', {}).get('percent')
            elif rule.type == 'process':
                if not rule.process_name:
                    return None
                cmd = safe_command("pgrep -f {name} | wc -l", name=rule.process_name)
                stdout, _ = session.execute_command(cmd, timeout=10)
                count = int(stdout.strip() or 0)
                return 1 if count > 0 else 0
        except Exception as e:
            log.error(f'[AlertEngine] 获取指标失败: {e}')
            return None
        finally:
            ssh_manager.remove_session(session_id)

    def _is_triggered(self, rule: AlertRule, value: float) -> bool:
        if rule.type == 'process':
            return value == 0
        return value > rule.threshold

    def _trigger_alert(self, rule: AlertRule, node: dict, value: float):
        key = f"{rule.id}:{node['id']}"
        now = time.time()

        with self._lock:
            last = self._last_alert.get(key, 0)
            if now - last < rule.cooldown:
                return
            self._last_alert[key] = now

        if rule.type == 'process':
            message = f"进程 {rule.process_name} 不存在"
        else:
            message = (
                f"{rule.type.upper()} 使用率 {value:.1f}% "
                f"超过阈值 {rule.threshold}%"
            )

        alert = Alert(
            rule_id=rule.id,
            node_id=node['id'],
            host=node['host'],
            message=message,
            value=value,
            severity=rule.severity,
        )

        with self._lock:
            self._alerts.append(alert)

        callbacks = list(self._callbacks)
        for cb in callbacks:
            try:
                cb(alert)
            except Exception as e:
                log.error(f'[AlertEngine] 回调失败: {e}')

        log.warning(f'[AlertEngine] 告警: {message} @ {node["host"]}')

    def get_alerts(self, limit: int = 100) -> List[Alert]:
        with self._lock:
            return sorted(
                self._alerts,
                key=lambda x: x.created_at,
                reverse=True
            )[:limit]

    def acknowledge_alert(self, alert_id: str) -> bool:
        with self._lock:
            for alert in self._alerts:
                if alert.id == alert_id:
                    alert.acknowledged = True
                    return True
        return False

    def clear_alerts(self):
        with self._lock:
            self._alerts.clear()


alert_engine = AlertEngine()