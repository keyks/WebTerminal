# backend/ai_config.py
"""
AI 配置管理模块

职责：
- 管理 ai_config.json 的读写（加密存储 API Key）
- 合并用户配置与环境变量（GROQ_API_KEY / GROQ_MODEL）
- 供 app.py 和 diagnose.py 共同导入，打破循环依赖

配置优先级（高→低）：
    1. ai_config.json（用户通过前端设置页面配置）── 加密存储
    2. .env 环境变量 (GROQ_API_KEY / GROQ_MODEL)
    3. 内置默认值
"""

import os
import json
import time
from pathlib import Path

from logger import log


# ══════════════════════════════════════════
#  缓存
# ══════════════════════════════════════════

_ai_config_cache = None
_ai_config_cache_time = 0
# 🔧 缓存时长（秒）：2 秒足够避免同一请求内重复 I/O，同时对配置更新敏感
_AI_CONFIG_CACHE_TTL = 2


def clear_ai_config_cache():
    """强制清空缓存，使下一次读取从磁盘重新加载"""
    global _ai_config_cache, _ai_config_cache_time
    _ai_config_cache = None
    _ai_config_cache_time = 0


def invalidate_stored_key() -> str:
    """删除 ai_config.json 中的 Key（403 等场景自动清理失效凭证）

    Returns:
        'deleted'  - Key 已从 ai_config.json 删除
        'no_file'  - ai_config.json 不存在，无需操作
        'error'    - 操作失败
    """
    cfg = _ai_cfg_path()
    if not cfg.exists():
        return 'no_file'

    try:
        raw = json.loads(cfg.read_text(encoding='utf-8'))
        changed = False
        if 'api_key_enc' in raw:
            del raw['api_key_enc']
            changed = True
        if 'api_key' in raw:
            del raw['api_key']
            changed = True

        if changed:
            if raw:  # 还有其他字段（model/base_url），保留
                cfg.write_text(
                    json.dumps(raw, ensure_ascii=False, indent=2),
                    encoding='utf-8'
                )
            else:  # 文件只剩空壳，直接删除
                cfg.unlink()
                log.info('[AI Config] ai_config.json 已删除（无剩余配置）')
                clear_ai_config_cache()
                return 'deleted'

            log.info('[AI Config] ai_config.json 中的 Key 已清除（保留其他配置）')
        else:
            log.debug('[AI Config] ai_config.json 中无 Key 可清除')

        clear_ai_config_cache()
        return 'deleted' if changed else 'no_key'

    except Exception as e:
        log.error(f'[AI Config] 清除 Key 失败: {e}')
        return 'error'


# ══════════════════════════════════════════
#  路径 & 加解密
# ══════════════════════════════════════════

def _ai_cfg_path() -> Path:
    """ai_config.json 的存储路径（DATA_DIR 下）"""
    from config import config
    return config.DATA_DIR / 'ai_config.json'


def _encrypt_key(plaintext: str) -> str:
    """加密 API Key，失败返回空字符串"""
    if not plaintext:
        return ''
    try:
        from config import config
        from cryptography.fernet import Fernet
        return Fernet(config.ENCRYPTION_KEY).encrypt(
            plaintext.encode('utf-8')
        ).decode('ascii')
    except Exception as e:
        log.error(f'[AI Config] 加密失败: {e}')
        return ''


def _decrypt_key(ciphertext: str) -> str:
    """解密 API Key，失败返回空字符串"""
    if not ciphertext:
        return ''
    try:
        from config import config
        from cryptography.fernet import Fernet
        return Fernet(config.ENCRYPTION_KEY).decrypt(
            ciphertext.encode('ascii')
        ).decode('utf-8').strip()
    except Exception as e:
        log.error(f'[AI Config] 解密失败: {e}')
        return ''


# ══════════════════════════════════════════
#  用户配置读写
# ══════════════════════════════════════════

def _load_ai_user_config() -> dict:
    """加载 AI 用户配置，自动解密 api_key

    从 DATA_DIR/ai_config.json 读取并解密 api_key。
    带短缓存（2 秒），避免同一请求内重复磁盘 I/O。
    """
    global _ai_config_cache, _ai_config_cache_time
    now = time.time()
    if _ai_config_cache is not None and (now - _ai_config_cache_time) < _AI_CONFIG_CACHE_TTL:
        return _ai_config_cache

    result = {'api_key': '', 'model': '', 'base_url': ''}
    cfg = _ai_cfg_path()

    try:
        if cfg.exists():
            raw = json.loads(cfg.read_text(encoding='utf-8'))
            result['base_url'] = raw.get('base_url', '').strip()
            result['model']    = raw.get('model', '').strip()

            if raw.get('api_key_enc'):
                result['api_key'] = _decrypt_key(raw['api_key_enc'])
                if result['api_key']:
                    log.debug(f'[AI Config] 已解密 api_key (len={len(result["api_key"])})')
                else:
                    log.warning(
                        '[AI Config] 解密 api_key_enc 失败！'
                        f' 文件={cfg}'
                        f' ENCRYPTION_KEY 是否发生变化？'
                        ' 如果是，请删除 ai_config.json 后重新配置。'
                    )
            elif raw.get('api_key'):
                result['api_key'] = raw.get('api_key', '').strip()
                log.info('[AI Config] 读取到明文 api_key（旧版兼容），建议重新保存以启用加密')
        else:
            log.debug(f'[AI Config] 配置文件不存在: {cfg}')
    except json.JSONDecodeError as e:
        log.error(f'[AI Config] ai_config.json 格式损坏: {e}，建议删除该文件重建')
    except PermissionError as e:
        log.error(f'[AI Config] ai_config.json 无读取权限: {e}')
    except Exception as e:
        log.error(f'[AI Config] 加载失败 ({type(e).__name__}): {e}')

    log.debug(f'[AI Config] 加载完成: configured={bool(result["api_key"])}, '
              f'model={result["model"] or "(默认)"}, base_url={result["base_url"] or "(默认)"}')

    _ai_config_cache = result
    _ai_config_cache_time = now
    return result


def save_ai_user_config(base_url: str = None,
                        api_key: str = None,
                        model: str = None) -> bool:
    """保存 AI 用户配置，api_key 加密存储"""
    global _ai_config_cache, _ai_config_cache_time
    cfg = _ai_cfg_path()

    try:
        raw = json.loads(cfg.read_text(encoding='utf-8')) if cfg.exists() else {}
    except Exception:
        raw = {}

    if base_url is not None:
        raw['base_url'] = base_url.strip()
    if model is not None:
        raw['model'] = model.strip()
    if api_key is not None and api_key.strip():
        enc = _encrypt_key(api_key.strip())
        if enc:
            raw['api_key_enc'] = enc
            raw.pop('api_key', None)
            log.info('[AI Config] api_key 已加密保存')
        else:
            raw['api_key'] = api_key.strip()
            raw.pop('api_key_enc', None)
            log.warning('[AI Config] 加密失败，以明文保存 api_key')

    try:
        cfg.write_text(
            json.dumps(raw, ensure_ascii=False, indent=2),
            encoding='utf-8'
        )
    except Exception as e:
        log.error(f'[AI Config] 写入失败: {e}')
        return False

    clear_ai_config_cache()
    return True


# ══════════════════════════════════════════
#  获取最终生效配置（合并优先级）
# ══════════════════════════════════════════

def get_effective_ai_config() -> dict:
    """获取生效的 AI 配置：用户配置优先，fallback 到环境变量

    优先级：
        1. ai_config.json（前端设置页面保存，加密存储）
        2. .env 环境变量 (GROQ_API_KEY / GROQ_MODEL)
        3. 内置默认值

    Returns:
        {
            'enabled':  bool,      # AI 是否启用
            'api_key':  str,       # 实际的 API Key
            'model':    str,       # 模型名称
            'base_url': str,       # API 端点 URL
        }
    """
    from config import config

    user = _load_ai_user_config()

    user_key     = user.get('api_key', '').strip()
    env_key      = config.GROQ_API_KEY.strip()
    user_model   = user.get('model', '').strip()
    user_baseurl = user.get('base_url', '').strip()

    final_key   = user_key or env_key
    final_model = user_model or config.GROQ_MODEL.strip() or 'llama-3.3-70b-versatile'
    final_baseurl = user_baseurl or 'https://api.groq.com/openai/v1'

    # 诊断辅助：当本地存储的 Key 与 .env 不同时给出明确警告
    # 🔧 增强：使用前缀比较避免泄露完整 Key 到日志
    if user_key and env_key and user_key != env_key:
        env_prefix = env_key[:8] if len(env_key) >= 8 else env_key[:4]
        user_prefix = user_key[:8] if len(user_key) >= 8 else user_key[:4]
        log.warning(
            f'[AI Config] ⚠️ ai_config.json 中的 Key（{user_prefix}...）与 '
            f'.env 的 GROQ_API_KEY（{env_prefix}...）不同！'
            ' 当前生效: ai_config.json，.env Key 被忽略。'
            ' 如果 ai_config.json 中的 Key 已过期，请通过前端设置页面更新，'
            ' 或删除该文件（位于 DATA_DIR）回退到 .env。'
        )
    elif user_key and env_key and user_key == env_key:
        log.debug('[AI Config] ai_config.json 与 .env Key 一致')
    elif user_key and not env_key:
        log.info('[AI Config] 使用 ai_config.json 中的 Key（.env 未设置 GROQ_API_KEY）')
    elif not user_key and env_key:
        log.info('[AI Config] 使用 .env GROQ_API_KEY（ai_config.json 无 Key）')
    elif not user_key and not env_key:
        log.warning('[AI Config] ⚠️ API Key 完全未配置：ai_config.json 和 .env 均无 Key')

    log.debug(f'[AI Config] effective: configured={bool(final_key)}, '
              f'model={final_model}, base_url={final_baseurl}')

    return {
        'enabled':  config.AI_ENABLED,
        'api_key':  final_key,
        'model':    final_model,
        'base_url': final_baseurl,
    }
