"""
SQLite 数据库管理 - 修复版
✅ 移除暴力重建逻辑
✅ 历史记录不返回明文密码
✅ 支持私钥密码独立字段
"""
import sqlite3
import uuid
from datetime import datetime
from contextlib import contextmanager
from cryptography.fernet import Fernet

from config import config
from logger import log


class Database:

    def __init__(self):
        self.db_path = config.DB_PATH
        self.cipher = Fernet(config.ENCRYPTION_KEY)
        self._init_db()

    @contextmanager
    def get_conn(self):
        conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=OFF")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_db(self):
        """
        ✅ 修复：逐表建立，绝不 DROP 已有表
        新增字段用 ALTER TABLE ADD COLUMN IF NOT EXISTS 方式追加
        """
        tables = {
            "users": '''
                CREATE TABLE IF NOT EXISTS users (
                    id            TEXT PRIMARY KEY,
                    username      TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_login    TIMESTAMP
                )
            ''',
            "groups": '''
                CREATE TABLE IF NOT EXISTS groups (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    user_id    TEXT DEFAULT "",
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''',
            "connections": '''
                CREATE TABLE IF NOT EXISTS connections (
                    id                        TEXT PRIMARY KEY,
                    name                      TEXT NOT NULL DEFAULT "",
                    host                      TEXT NOT NULL DEFAULT "",
                    port                      INTEGER DEFAULT 22,
                    username                  TEXT DEFAULT "root",
                    password_enc              TEXT DEFAULT "",
                    private_key_enc           TEXT DEFAULT "",
                    private_key_passphrase_enc TEXT DEFAULT "",
                    group_id                  TEXT DEFAULT NULL,
                    color                     TEXT DEFAULT "#00b894",
                    description               TEXT DEFAULT "",
                    user_id                   TEXT DEFAULT "",
                    created_at                TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_connected            TIMESTAMP
                )
            ''',
            "quick_connect_history": '''
                CREATE TABLE IF NOT EXISTS quick_connect_history (
                    id           TEXT PRIMARY KEY,
                    host         TEXT NOT NULL,
                    port         INTEGER DEFAULT 22,
                    username     TEXT DEFAULT "root",
                    password_enc TEXT DEFAULT "",
                    last_used    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    use_count    INTEGER DEFAULT 1
                )
            ''',
            "audit_logs": '''
                CREATE TABLE IF NOT EXISTS audit_logs (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    action     TEXT NOT NULL,
                    user       TEXT DEFAULT "",
                    target     TEXT DEFAULT "",
                    detail     TEXT DEFAULT "",
                    ip         TEXT DEFAULT "",
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''',
            "command_shortcuts": '''
                CREATE TABLE IF NOT EXISTS command_shortcuts (
                    id          TEXT PRIMARY KEY,
                    name        TEXT NOT NULL,
                    command     TEXT NOT NULL,
                    description TEXT DEFAULT "",
                    user_id     TEXT DEFAULT "",
                    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''',
            "distribution_tasks": '''
                CREATE TABLE IF NOT EXISTS distribution_tasks (
                    task_id         TEXT PRIMARY KEY,
                    source_path     TEXT NOT NULL,
                    target_path     TEXT NOT NULL,
                    target_nodes    TEXT NOT NULL DEFAULT "[]",
                    strategy        TEXT DEFAULT "overwrite",
                    status          TEXT DEFAULT "pending",
                    total_nodes     INTEGER DEFAULT 0,
                    completed_nodes INTEGER DEFAULT 0,
                    results         TEXT DEFAULT "{}",
                    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''',
        }

        indexes = [
            "CREATE INDEX IF NOT EXISTS idx_conn_group  ON connections(group_id)",
            "CREATE INDEX IF NOT EXISTS idx_audit_time  ON audit_logs(created_at)",
            "CREATE INDEX IF NOT EXISTS idx_quick_host  ON quick_connect_history(host,port,username)",
        ]

        with self.get_conn() as conn:
            for tname, ddl in tables.items():
                try:
                    conn.execute(ddl)
                except Exception as e:
                    log.error(f'建表 {tname} 失败: {e}')

            # ✅ 追加新字段（兼容旧数据库，不破坏已有数据）
            self._add_column_if_missing(
                conn, 'connections',
                'private_key_passphrase_enc', 'TEXT DEFAULT ""'
            )

            for idx in indexes:
                try:
                    conn.execute(idx)
                except Exception:
                    pass

        log.info(f'数据库已就绪: {self.db_path}')

    def _add_column_if_missing(self, conn, table: str, column: str, col_def: str):
        """安全追加列，已存在则跳过"""
        try:
            cols = [row[1] for row in conn.execute(f'PRAGMA table_info({table})').fetchall()]
            if column not in cols:
                conn.execute(f'ALTER TABLE {table} ADD COLUMN {column} {col_def}')
                log.info(f'已追加字段 {table}.{column}')
        except Exception as e:
            log.warning(f'追加字段 {table}.{column} 失败: {e}')

    # ════════════════════════════════
    #  加密工具
    # ════════════════════════════════

    def encrypt(self, plaintext: str) -> str:
        if not plaintext:
            return ''
        try:
            return self.cipher.encrypt(plaintext.encode()).decode()
        except Exception:
            return ''

    def decrypt(self, ciphertext: str) -> str:
        if not ciphertext:
            return ''
        try:
            return self.cipher.decrypt(ciphertext.encode()).decode()
        except Exception as e:
            # 🔧 记录详细错误，便于定位密钥损坏或权限问题
            log.error(f'[Database] 解密失败: {e} | ciphertext[:20]={ciphertext[:20]}')
            return ''

    @staticmethod
    def _to_none(val):
        return None if (val is None or val == '') else val

    @staticmethod
    def _to_str(val):
        return '' if val is None else str(val)

    def _row_to_conn(self, row) -> dict:
        d = dict(row)
        d['password']             = self.decrypt(d.pop('password_enc', ''))
        d['private_key']          = self.decrypt(d.pop('private_key_enc', ''))
        d['private_key_passphrase'] = self.decrypt(
            d.pop('private_key_passphrase_enc', '')
        )
        d['group_id']    = self._to_str(d.get('group_id'))
        d['description'] = self._to_str(d.get('description'))
        return d

    # ════════════════════════════════
    #  分组
    # ════════════════════════════════

    def get_groups(self) -> list:
        with self.get_conn() as conn:
            return [dict(r) for r in
                    conn.execute('SELECT * FROM groups ORDER BY name').fetchall()]

    def get_group(self, group_id: str) -> dict | None:
        if not group_id:
            return None
        with self.get_conn() as conn:
            row = conn.execute(
                'SELECT * FROM groups WHERE id=?', (group_id,)
            ).fetchone()
            return dict(row) if row else None

    def add_group(self, name: str, user_id: str = '') -> dict:
        gid = str(uuid.uuid4())[:8]
        with self.get_conn() as conn:
            conn.execute(
                'INSERT INTO groups(id, name, user_id) VALUES(?,?,?)',
                (gid, name.strip(), user_id)
            )
        return {'id': gid, 'name': name.strip(), 'user_id': user_id}

    def delete_group(self, group_id: str):
        with self.get_conn() as conn:
            conn.execute(
                'UPDATE connections SET group_id=NULL WHERE group_id=?', (group_id,)
            )
            conn.execute('DELETE FROM groups WHERE id=?', (group_id,))

    # ════════════════════════════════
    #  连接 CRUD
    # ════════════════════════════════

    def get_all_connections(self) -> list:
        with self.get_conn() as conn:
            return [self._row_to_conn(r) for r in
                    conn.execute('SELECT * FROM connections ORDER BY name').fetchall()]

    def get_all_connections_light(self) -> list:
        """仅返回非敏感字段，避免读取/解密 password_enc 等大字段（列表页用）"""
        cols = ('id','name','host','port','username','group_id','color',
                'description','created_at','last_connected')
        with self.get_conn() as conn:
            return [dict(r) for r in conn.execute(
                f'SELECT {",".join(cols)} FROM connections ORDER BY name'
            ).fetchall()]

    def get_connection(self, conn_id: str) -> dict | None:
        with self.get_conn() as conn:
            row = conn.execute(
                'SELECT * FROM connections WHERE id=?', (conn_id,)
            ).fetchone()
            return self._row_to_conn(row) if row else None

    def add_connection(self, info: dict) -> dict:
        cid      = str(uuid.uuid4())[:8]
        now      = datetime.now().isoformat()
        group_id = self._to_none(info.get('group_id', ''))
        if group_id and not self.get_group(group_id):
            group_id = None

        with self.get_conn() as conn:
            conn.execute('''
                INSERT INTO connections
                    (id, name, host, port, username,
                     password_enc, private_key_enc, private_key_passphrase_enc,
                     group_id, color, description, user_id, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ''', (
                cid,
                (info.get('name') or info.get('host', '')).strip(),
                info.get('host', '').strip(),
                int(info.get('port', 22)),
                (info.get('username') or 'root').strip(),
                self.encrypt(info.get('password', '')),
                self.encrypt(info.get('private_key', '')),
                self.encrypt(info.get('private_key_passphrase', '')),
                group_id,
                info.get('color', '#00b894'),
                info.get('description', ''),
                info.get('user_id', ''),
                now,
            ))
        return self.get_connection(cid)

    def update_connection(self, conn_id: str, info: dict) -> dict | None:
        old = self.get_connection(conn_id)
        if not old:
            return None

        group_id = self._to_none(info.get('group_id', old.get('group_id', '')))
        if group_id and not self.get_group(group_id):
            group_id = None

        # 🔧 修复：允许清空密码/私钥（通过显式传入 None 或特定标记来清空）
        # 如果 info 中不包含该字段，则保留旧值；如果显式传入空字符串或 None，则清空
        if 'password' in info:
            new_pw = info['password']
            pw_enc = self.encrypt(new_pw) if new_pw else ''
        else:
            pw_enc = self.encrypt(old.get('password', ''))

        if 'private_key' in info:
            new_key = info['private_key']
            key_enc = self.encrypt(new_key) if new_key else ''
        else:
            key_enc = self.encrypt(old.get('private_key', ''))

        if 'private_key_passphrase' in info:
            new_pp = info['private_key_passphrase']
            pp_enc = self.encrypt(new_pp) if new_pp else ''
        else:
            pp_enc = self.encrypt(old.get('private_key_passphrase', ''))

        with self.get_conn() as conn:
            conn.execute('''
                UPDATE connections SET
                    name=?, host=?, port=?, username=?,
                    password_enc=?, private_key_enc=?, private_key_passphrase_enc=?,
                    group_id=?, color=?, description=?
                WHERE id=?
            ''', (
                (info.get('name') or old['name']).strip(),
                (info.get('host') or old['host']).strip(),
                int(info.get('port', old['port'])),
                (info.get('username') or old['username']).strip(),
                pw_enc, key_enc, pp_enc,
                group_id,
                info.get('color', old['color']),
                info.get('description', old.get('description', '')),
                conn_id,
            ))
        return self.get_connection(conn_id)

    def delete_connection(self, conn_id: str):
        with self.get_conn() as conn:
            conn.execute('DELETE FROM connections WHERE id=?', (conn_id,))

    def update_last_connected(self, conn_id: str):
        with self.get_conn() as conn:
            conn.execute(
                'UPDATE connections SET last_connected=? WHERE id=?',
                (datetime.now().isoformat(), conn_id)
            )

    # ════════════════════════════════
    #  快速连接历史（✅ 不返回明文密码）
    # ════════════════════════════════

    def get_quick_history(self, limit: int = 20) -> list:
        with self.get_conn() as conn:
            rows = conn.execute(
                'SELECT * FROM quick_connect_history ORDER BY last_used DESC LIMIT ?',
                (limit,)
            ).fetchall()
            result = []
            for r in rows:
                d = dict(r)
                # ✅ 只返回是否有密码，不返回明文
                d['has_password'] = bool(d.pop('password_enc', ''))
                result.append(d)
            return result

    def upsert_quick_history(self, host: str, port: int,
                              username: str, password: str):
        with self.get_conn() as conn:
            existing = conn.execute(
                '''SELECT id FROM quick_connect_history
                   WHERE host=? AND port=? AND username=?''',
                (host, int(port), username)
            ).fetchone()

            now = datetime.now().isoformat()
            if existing:
                conn.execute('''
                    UPDATE quick_connect_history
                    SET last_used=?, use_count=use_count+1, password_enc=?
                    WHERE id=?
                ''', (now, self.encrypt(password), existing['id']))
            else:
                count = conn.execute(
                    'SELECT COUNT(*) as c FROM quick_connect_history'
                ).fetchone()['c']
                if count >= config.QUICK_CONNECT_HISTORY_MAX:
                    oldest = conn.execute(
                        'SELECT id FROM quick_connect_history ORDER BY last_used ASC LIMIT 1'
                    ).fetchone()
                    if oldest:
                        conn.execute(
                            'DELETE FROM quick_connect_history WHERE id=?',
                            (oldest['id'],)
                        )
                hid = str(uuid.uuid4())[:8]
                conn.execute('''
                    INSERT INTO quick_connect_history
                        (id, host, port, username, password_enc, last_used, use_count)
                    VALUES (?,?,?,?,?,?,1)
                ''', (hid, host, int(port), username, self.encrypt(password), now))

    def delete_quick_history(self, history_id: str):
        with self.get_conn() as conn:
            conn.execute(
                'DELETE FROM quick_connect_history WHERE id=?', (history_id,)
            )

    def clear_quick_history(self):
        with self.get_conn() as conn:
            conn.execute('DELETE FROM quick_connect_history')

    # ════════════════════════════════
    #  审计日志
    # ════════════════════════════════

    def add_audit(self, action: str, user: str = '', target: str = '',
                  detail: str = '', ip: str = ''):
        """🔧 审计日志写入，异常时记录错误日志并尝试文件备份"""
        try:
            with self.get_conn() as conn:
                conn.execute(
                    'INSERT INTO audit_logs(action,user,target,detail,ip) VALUES(?,?,?,?,?)',
                    (action, user, target, detail, ip)
                )
        except Exception as e:
            # 🔧 修复：记录错误日志，而非仅 warning
            log.error(f'审计日志写入失败: {e}', exc_info=True)
            # 🔧 尝试写入文件备份
            try:
                import os as _os
                from datetime import datetime as _dt
                backup_file = config.DATA_DIR / 'audit_fallback.log'
                with open(str(backup_file), 'a', encoding='utf-8') as f:
                    f.write(f"{_dt.now().isoformat()} | {action} | {user} | {target} | {detail} | {ip}\n")
            except Exception:
                pass

    def get_audit_logs(self, limit: int = 100) -> list:
        with self.get_conn() as conn:
            return [dict(r) for r in conn.execute(
                'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?', (limit,)
            ).fetchall()]

    # ════════════════════════════════
    #  快捷命令
    # ════════════════════════════════

    def get_shortcuts(self) -> list:
        with self.get_conn() as conn:
            return [dict(r) for r in
                    conn.execute('SELECT * FROM command_shortcuts ORDER BY name').fetchall()]

    def add_shortcut(self, name: str, command: str,
                     description: str = '', user_id: str = '') -> dict:
        if not name.strip() or not command.strip():
            raise ValueError('名称和命令不能为空')
        sid = str(uuid.uuid4())[:8]
        with self.get_conn() as conn:
            conn.execute('''
                INSERT INTO command_shortcuts(id, name, command, description, user_id)
                VALUES (?,?,?,?,?)
            ''', (sid, name.strip(), command.strip(), description, user_id))
        return {'id': sid, 'name': name.strip(),
                'command': command.strip(), 'description': description}

    def update_shortcut(self, sid: str, name: str,
                        command: str, description: str = ''):
        with self.get_conn() as conn:
            conn.execute('''
                UPDATE command_shortcuts SET name=?, command=?, description=?
                WHERE id=?
            ''', (name.strip(), command.strip(), description, sid))

    def delete_shortcut(self, sid: str):
        with self.get_conn() as conn:
            conn.execute('DELETE FROM command_shortcuts WHERE id=?', (sid,))

    # ════════════════════════════════
    #  文件分发任务持久化
    # ════════════════════════════════

    def save_distribute_task(self, task_id: str, source_path: str,
                              target_path: str, node_ids: list,
                              strategy: str = 'overwrite'):
        import json as _json
        with self.get_conn() as conn:
            conn.execute('''
                INSERT OR REPLACE INTO distribution_tasks
                    (task_id, source_path, target_path, target_nodes,
                     strategy, status, total_nodes, completed_nodes, results)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                task_id, source_path, target_path,
                _json.dumps(node_ids),
                strategy, 'running', len(node_ids), 0, '{}'
            ))

    def update_distribute_task(self, task_id: str, status: str = None,
                                completed_nodes: int = None, results: dict = None):
        import json as _json
        with self.get_conn() as conn:
            updates = []
            params = []
            if status is not None:
                updates.append('status=?')
                params.append(status)
            if completed_nodes is not None:
                updates.append('completed_nodes=?')
                params.append(completed_nodes)
            if results is not None:
                updates.append('results=?')
                params.append(_json.dumps(results))
            if not updates:
                return
            updates.append('updated_at=CURRENT_TIMESTAMP')
            params.append(task_id)
            conn.execute(
                f'UPDATE distribution_tasks SET {", ".join(updates)} WHERE task_id=?',
                params
            )

    def get_distribute_task(self, task_id: str) -> dict | None:
        import json as _json
        with self.get_conn() as conn:
            row = conn.execute(
                'SELECT * FROM distribution_tasks WHERE task_id=?', (task_id,)
            ).fetchone()
            if not row:
                return None
            d = dict(row)
            try:
                d['target_nodes'] = _json.loads(d.get('target_nodes', '[]'))
            except Exception:
                d['target_nodes'] = []
            try:
                d['results'] = _json.loads(d.get('results', '{}'))
            except Exception:
                d['results'] = {}
            return d

    def get_active_distribute_tasks(self) -> list:
        import json as _json
        with self.get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM distribution_tasks WHERE status='running' "
                "ORDER BY created_at DESC LIMIT 50"
            ).fetchall()
            result = []
            for row in rows:
                d = dict(row)
                try:
                    d['target_nodes'] = _json.loads(d.get('target_nodes', '[]'))
                except Exception:
                    d['target_nodes'] = []
                try:
                    d['results'] = _json.loads(d.get('results', '{}'))
                except Exception:
                    d['results'] = {}
                result.append(d)
            return result


db = Database()