# backend/session_recovery.py
"""
智能会话状态记忆系统
- 持久化会话状态 (Redis)
- 自动重建终端上下文
- 跨页面/跨标签恢复
"""
import json
import time
import hashlib
from typing import Optional, Dict, Any
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta

# 🔧 修复：不在模块加载时连接 Redis，改为惰性初始化
redis_client = None
_redis_init_attempted = False
_redis_available = None  # None=未尝试, True=可用, False=不可用


def _get_redis_client():
    """惰性初始化 Redis 连接，失败时优雅降级到内存存储"""
    global redis_client, _redis_init_attempted, _redis_available

    # 已经成功连接，直接返回
    if _redis_available is True and redis_client is not None:
        return redis_client

    # 已经确认不可用，不再尝试
    if _redis_available is False:
        return None

    # 首次尝试连接
    if not _redis_init_attempted:
        _redis_init_attempted = True
        try:
            import redis as _redis
            from config import config
            client = _redis.Redis(
                host=config.REDIS_HOST,
                port=config.REDIS_PORT,
                password=config.REDIS_PASSWORD or None,
                decode_responses=True,
                socket_keepalive=True,
                socket_connect_timeout=2,
            )
            client.ping()
            redis_client = client
            _redis_available = True
            print("[INFO] Redis 连接成功，会话恢复功能已启用")
            return redis_client
        except Exception as e:
            _redis_available = False
            print(f"[WARNING] Redis 不可用 ({e})，会话恢复将使用内存存储（重启后丢失）")
            return None

    return None
@dataclass
class SessionSnapshot:
    session_id: str
    conn_id: str
    host: str
    port: int
    username: str
    created_at: str
    last_active: str
    terminal_state: Dict[str, Any]
    pwd: str
    env_vars: Dict[str, str]
    history: list[str]
    screen_buffer: str
    
    def to_json(self) -> str:
        return json.dumps(asdict(self))
    
    @classmethod
    def from_json(cls, data: str) -> 'SessionSnapshot':
        return cls(**json.loads(data))


class SessionRecoveryManager:
    SESSION_PREFIX = 'wt:session:'
    RECOVERY_TTL = 3600 * 24 * 7
    
    # 内存存储（Redis 不可用时降级）
    _memory_store: Dict[str, str] = {}
    
    @classmethod
    def _get_client(cls):
        return _get_redis_client()
    
    @classmethod
    def save_snapshot(cls, session_id: str, snapshot: SessionSnapshot):
        key = f"{cls.SESSION_PREFIX}{session_id}"
        data = snapshot.to_json()
        
        client = cls._get_client()
        if client:
            client.setex(key, cls.RECOVERY_TTL, data)
            user_key = f"{cls.SESSION_PREFIX}user:{snapshot.username}:sessions"
            client.sadd(user_key, session_id)
            client.expire(user_key, cls.RECOVERY_TTL)
        else:
            # 内存存储（降级）
            cls._memory_store[key] = data
            cls._memory_store[f"{cls.SESSION_PREFIX}user:{snapshot.username}:sessions"] = session_id
    
    @classmethod
    def get_snapshot(cls, session_id: str) -> Optional[SessionSnapshot]:
        key = f"{cls.SESSION_PREFIX}{session_id}"
        
        client = cls._get_client()
        if client:
            data = client.get(key)
        else:
            data = cls._memory_store.get(key)
        
        if data:
            return SessionSnapshot.from_json(data)
        return None
    
    @classmethod
    def delete_snapshot(cls, session_id: str):
        key = f"{cls.SESSION_PREFIX}{session_id}"
        
        client = cls._get_client()
        if client:
            client.delete(key)
        else:
            cls._memory_store.pop(key, None)
    
    @classmethod
    def list_user_sessions(cls, username: str) -> list[str]:
        user_key = f"{cls.SESSION_PREFIX}user:{username}:sessions"
        
        client = cls._get_client()
        if client:
            return client.smembers(user_key) or []
        else:
            val = cls._memory_store.get(user_key)
            return [val] if val else []
    
    @classmethod
    def is_session_recoverable(cls, session_id: str) -> bool:
        key = f"{cls.SESSION_PREFIX}{session_id}"
        
        client = cls._get_client()
        if client:
            return client.exists(key) > 0
        else:
            return key in cls._memory_store