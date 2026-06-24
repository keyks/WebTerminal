#!/usr/bin/env python3
# backend/_groq_worker.py
"""
独立 Groq API 调用进程
由 ai_engine.py 通过 subprocess 启动
完全独立于 eventlet，使用 httpx 同步客户端直接请求
"""
import sys
import json
import os as _os
import time
import traceback
from datetime import datetime as _dt
from pathlib import Path as _Path

# 🔧 修复 Windows 控制台中文乱码（子进程独立运行，需要单独设置）
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        import io as _io
        sys.stdout = _io.TextIOWrapper(
            sys.stdout.buffer, encoding='utf-8', errors='replace', line_buffering=True
        )
        sys.stderr = _io.TextIOWrapper(
            sys.stderr.buffer, encoding='utf-8', errors='replace', line_buffering=True
        )

# 🔧 Windows 服务诊断：将 stderr 同时重定向到日志文件
_WORKER_LOG_DIR = _Path('C:/Users/A/.webterminal/logs')
try:
    _WORKER_LOG_DIR.mkdir(parents=True, exist_ok=True)
    _WORKER_LOG = open(str(_WORKER_LOG_DIR / 'worker_stderr.log'), 'a', encoding='utf-8')
    _WORKER_LOG.write(f'\n=== {_dt.now().isoformat()} pid={_os.getpid()} ===\n')
    _WORKER_LOG.flush()
    # Tee 类：同时写入原 stderr 和文件
    class _TeeStderr:
        def write(self, s):
            # 🔧 修复：原始 sys.__stderr__ 在 Windows 服务中可能是 ASCII，
            # 用 errors='replace' 防止 UnicodeEncodeError 崩溃主进程
            try:
                sys.__stderr__.write(s)
                sys.__stderr__.flush()
            except (UnicodeEncodeError, UnicodeDecodeError):
                try:
                    sys.__stderr__.write(s.encode('ascii', errors='replace').decode('ascii'))
                    sys.__stderr__.flush()
                except Exception:
                    pass
            try:
                _WORKER_LOG.write(s)
                _WORKER_LOG.flush()
            except Exception:
                pass
        def flush(self):
            sys.__stderr__.flush()
            try:
                _WORKER_LOG.flush()
            except Exception:
                pass
    sys.stderr = _TeeStderr()
except Exception:
    pass  # 日志目录创建失败不影响主流程


def call_groq(params: dict) -> dict:
    """使用 httpx 同步客户端直接调用 Groq API"""
    import httpx

    api_key    = params['api_key']
    base_url   = params.get('base_url', '').strip()
    model      = params.get('model', 'openai/gpt-oss-120b')
    messages   = params['messages']
    max_tokens = params.get('max_tokens', 1500)
    json_mode  = params.get('json_mode', False)

    # 诊断
    key_prefix = api_key[:8] if api_key else '(空)'
    print(f'[_groq_worker] Key={key_prefix}... len={len(api_key)} base={base_url or "default"} model={model}', file=sys.stderr)
    env_http  = _os.environ.get('HTTP_PROXY', '')
    env_https = _os.environ.get('HTTPS_PROXY', '')
    env_no_proxy = _os.environ.get('NO_PROXY', '')
    print(f'[_groq_worker] Python={sys.version[:50]} HTTPS_PROXY={env_https[:50]} HTTP_PROXY={env_http[:50]} NO_PROXY={env_no_proxy[:50]}', file=sys.stderr)
    print(f'[_groq_worker] CWD={_os.getcwd()} pid={_os.getpid()}', file=sys.stderr)

    url = (base_url or 'https://api.groq.com/openai/v1') + '/chat/completions'

    body = {
        'model':       model,
        'messages':    messages,
        'temperature': 0.2,
        'max_tokens':  max_tokens,
    }
    if json_mode:
        body['response_format'] = {'type': 'json_object'}

    print(f'[_groq_worker] POST {url} msgs={len(messages)} max_tokens={max_tokens} json={json_mode}', file=sys.stderr)

    # 🔧 代理策略：优先使用环境变量，未设置时让 httpx 自动检测系统代理
    env_proxy = _os.environ.get('HTTPS_PROXY', '') or _os.environ.get('HTTP_PROXY', '')
    if env_proxy:
        print(f'[_groq_worker] 使用代理: {env_proxy[:50]}', file=sys.stderr)
        proxy_kw = {'proxy': env_proxy}
    else:
        print(f'[_groq_worker] 无环境变量代理，直连', file=sys.stderr)
        proxy_kw = {}

    # 诊断：httpx 版本
    print(f'[_groq_worker] httpx={httpx.__version__}', file=sys.stderr)

    # 🔁 自动重试：代理隧道 SSL 断开属暂时性故障，退避重试最多 3 次
    MAX_RETRIES = 3
    resp = None
    last_error = None

    for attempt in range(1, MAX_RETRIES + 1):
        if attempt > 1:
            wait = 2 ** (attempt - 1)  # 2, 4 秒退避
            print(f'[_groq_worker] 🔁 重试 {attempt}/{MAX_RETRIES}（等待 {wait}s）...', file=sys.stderr)
            time.sleep(wait)

        try:
            resp = httpx.post(
                url,
                headers={
                    'Authorization': f'Bearer {api_key}',
                    'Content-Type':  'application/json',
                },
                json=body,
                timeout=15,
                verify=False,
                trust_env=False,
                **proxy_kw,
            )
            last_error = None
            break  # 成功，跳出重试循环
        except httpx.ConnectTimeout:
            last_error = ('timeout', f'Groq API 连接超时（15s）')
        except httpx.ReadTimeout:
            last_error = ('timeout', f'Groq API 读取超时（15s）')
        except httpx.ConnectError as e:
            err_msg = str(e)
            # SSL/EOF 类错误可重试；DNS/refused 不可重试
            is_retryable = any(kw in err_msg.lower() for kw in
                ('ssl', 'eof', 'unexpected_eof', 'timeout', 'reset', 'connection aborted'))
            if is_retryable:
                print(f'[_groq_worker] ⚠️ 连接错误（可重试）: {type(e).__name__}: {err_msg[:120]}', file=sys.stderr)
                last_error = ('connect', f'{type(e).__name__}: {err_msg[:300]}')
                continue  # 重试
            else:
                # 不可重试的错误（DNS、refused）直接返回
                if 'getaddrinfo' in err_msg.lower() or 'nodename' in err_msg.lower() or 'name or service not known' in err_msg.lower():
                    return {'error': f'DNS 解析失败: 无法解析 api.groq.com → 请检查 DNS/网络。代理: {env_proxy or "自动检测"}'}
                if 'connection refused' in err_msg.lower():
                    return {'error': f'连接被拒绝: {err_msg} → 代理: {env_proxy or "自动检测"}'}
                return {'error': f'Groq API 连接失败: {err_msg[:300]} → 代理: {env_proxy or "自动检测"}'}
        except Exception as e:
            last_error = ('other', f'{type(e).__name__}: {e}')
            # 其他异常也尝试重试一次
            print(f'[_groq_worker] ⚠️ 未知异常（尝试重试）: {type(e).__name__}: {e}', file=sys.stderr)

    # 所有重试都失败
    if resp is None:
        err_type, err_msg = last_error or ('unknown', 'Unknown error')
        return {'error': f'Groq API 请求失败（{MAX_RETRIES}次尝试后）: {err_msg}'}

    print(f'[_groq_worker] HTTP {resp.status_code}', file=sys.stderr)

    if resp.status_code != 200:
        body_text = resp.text[:500]
        print(f'[_groq_worker] Error body: {body_text}', file=sys.stderr)
        if resp.status_code == 403:
            # 🔬 用简单消息再试一次，排除消息内容差异
            # 🔧 补充 verify=False + trust_env=False，与主请求保持一致
            print(f'[_groq_worker] 🔬 403 对比：尝试简单消息...', file=sys.stderr)
            for a2 in range(1, 4):
                if a2 > 1:
                    time.sleep(2 ** (a2 - 1))
                try:
                    r2 = httpx.post(url,
                        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
                        json={'model': model, 'messages': [{'role': 'user', 'content': 'hi'}]},
                        timeout=30, verify=False, trust_env=False, **proxy_kw)
                    break
                except Exception:
                    if a2 == 3:
                        r2 = None
                    continue
            if r2 is not None:
                print(f'[_groq_worker] 🔬 简单消息结果: HTTP {r2.status_code}', file=sys.stderr)
                if r2.status_code != 200:
                    print(f'[_groq_worker] 🔬 简单消息 body: {r2.text[:300]}', file=sys.stderr)
                else:
                    print(f'[_groq_worker] 🔬 简单消息成功！是原始请求内容导致的 403', file=sys.stderr)
            else:
                print(f'[_groq_worker] 🔬 简单消息也多次失败', file=sys.stderr)
            return {'error': f'API Key 无效或无权限 (403 Forbidden) | 响应: {body_text} | Key[{key_prefix}...]'}
        elif resp.status_code == 429:
            # 限流：Groq 免费 tier TPM 6000，提取建议等待时间后重试
            wait_sec = 15.0  # 默认
            try:
                if 'try again in ' in body_text:
                    wait_str = body_text.split('try again in ')[1].split('s')[0]
                    wait_sec = float(wait_str) + 2.0  # 多等 2s 保底
            except Exception:
                pass
            print(f'[_groq_worker] ⏳ 限流 429，等待 {wait_sec:.1f}s 重试...', file=sys.stderr)
            time.sleep(wait_sec)
            try:
                resp2 = httpx.post(url,
                    headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
                    json=body, timeout=60, verify=False, trust_env=False, **proxy_kw)
                if resp2.status_code == 200:
                    resp = resp2  # 重试成功，交给下面解析
                else:
                    return {'error': f'限流重试后仍失败 HTTP {resp2.status_code} | {resp2.text[:300]}'}
            except Exception as e_ratelimit:
                return {'error': f'限流重试网络异常: {type(e_ratelimit).__name__}: {e_ratelimit}'}
        elif resp.status_code == 401:
            return {'error': f'API Key 认证失败 (401 Unauthorized) | 响应: {body_text} | Key[{key_prefix}...]'}
        else:
            return {'error': f'HTTP {resp.status_code} | 响应: {body_text}'}

    # ====== HTTP 200：解析响应 ======
    data = resp.json()
    text = data['choices'][0]['message']['content']

    if json_mode:
        # json_mode=True 时 Groq 服务端已校验，直接解析
        try:
            parsed = json.loads(text)
            return {'text': text, 'data': _ensure_dict(parsed)}
        except json.JSONDecodeError as e:
            # 🔧 返回含 text 字段的 error，避免 ai_engine 拿到 None
            return {'text': text, 'error': f'JSON 解析失败: {e}'}
    else:
        # json_mode=False → 客户端智能提取 JSON
        parsed = _extract_json(text)
        if parsed:
            # 成功提取到 JSON，返回 data 字段供调用方使用
            return {'text': text, 'data': _ensure_dict(parsed)}
        else:
            # 纯文本对话，返回原始文本
            return {'text': text}


def _extract_json(text: str) -> dict:
    """从 LLM 文本输出中提取 JSON（兼容 markdown 代码块、纯文本等多种格式）"""
    import re as _re

    if not text or not text.strip():
        return {}

    text = text.strip()

    # 1. 直接解析
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 2. 提取 ```json ... ``` 或 ``` ... ``` 代码块
    _m = _re.search(r'```(?:json)?\s*\n?(.*?)\n?```', text, _re.DOTALL)
    if _m:
        try:
            return json.loads(_m.group(1).strip())
        except json.JSONDecodeError:
            pass

    # 3. 找最外层 { ... }（处理前后有解释文字的情况）
    _m2 = _re.search(r'\{.*\}', text, _re.DOTALL)
    if _m2:
        try:
            return json.loads(_m2.group(0))
        except json.JSONDecodeError:
            pass

    # 4. 找最外层 [ ... ]（列表格式）
    _m3 = _re.search(r'\[.*\]', text, _re.DOTALL)
    if _m3:
        try:
            return json.loads(_m3.group(0))
        except json.JSONDecodeError:
            pass

    # 全部失败 → 返回空字典，调用方用 setdefault 填充默认值
    print(f'[_groq_worker] ⚠️ JSON 提取失败，原始文本前200字: {text[:200]}', file=sys.stderr)
    return {}


def _ensure_dict(data: dict) -> dict:
    """确保返回的 dict 包含诊断/拓扑等接口所需的默认字段"""
    data.setdefault('summary', '未返回摘要')
    data.setdefault('diagnosis', '未返回详情')
    data.setdefault('recommendations', [])
    data.setdefault('commands', [])
    if not isinstance(data.get('recommendations'), list):
        data['recommendations'] = [str(data['recommendations'])]
    if not isinstance(data.get('commands'), list):
        data['commands'] = [str(data['commands'])]
    return data


def main():
    if len(sys.argv) != 3:
        print(json.dumps({'error': '参数错误，需要 input_path output_path'}))
        sys.exit(1)

    input_path  = sys.argv[1]
    output_path = sys.argv[2]

    params = {}
    try:
        with open(input_path, 'r', encoding='utf-8') as f:
            params = json.load(f)
    except Exception as e:
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump({'error': f'读取输入文件失败: {e}'}, f)
        sys.exit(1)

    api_key  = params.get('api_key', '')
    base_url = params.get('base_url', '').strip()
    model    = params.get('model', 'openai/gpt-oss-120b')

    try:
        result = call_groq(params)

        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False)

    except Exception as e:
        err_msg = str(e)
        orig_msg = err_msg
        traceback.print_exc(file=sys.stderr)
        key_prefix = api_key[:8] if api_key else '(空)'
        diag_info = f'Key[{key_prefix}...] len={len(api_key)} base_url=[{base_url or "default"}] model=[{model}]'
        if '403' in err_msg or 'Forbidden' in err_msg:
            err_msg = f'API Key 无效或无权限 (403 Forbidden) | 原始: {orig_msg[:500]} | 环境: {diag_info}'
        elif '401' in err_msg or 'Unauthorized' in err_msg:
            err_msg = f'API Key 认证失败 (401 Unauthorized) | 原始: {orig_msg[:500]} | 环境: {diag_info}'
        else:
            err_msg = f'{orig_msg[:500]} | 环境: {diag_info}'
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump({'error': err_msg}, f)


if __name__ == '__main__':
    main()
