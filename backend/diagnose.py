# backend/diagnose.py
"""
AI 诊断引擎 - 调用 AI API（支持 Groq / OpenAI 兼容接口）进行智能运维分析
"""
import os
import json
import time
import asyncio
from typing import Dict, Any, Optional
from openai import AsyncOpenAI

from logger import log
from ssh_manager import SSHManager


class GroqDiagnosticEngine:
    """AI 诊断引擎（支持 Groq / OpenAI 兼容接口）"""

    def __init__(self, api_key: str, base_url: str = None, model: str = None):
        self.client = AsyncOpenAI(
            base_url=base_url or 'https://api.groq.com/openai/v1',
            api_key=api_key,
        )

        try:
            from config import config
            self.model = model or getattr(config, 'GROQ_MODEL', 'openai/gpt-oss-120b')
        except Exception:
            self.model = model or 'openai/gpt-oss-120b'

        self.command_timeout = 5   # 单条命令超时（秒）
        self.total_budget    = 35  # 上下文采集总预算（秒）
        self.api_timeout     = 45  # AI API 调用超时（秒）

    # ══════════════════════════════════════════
    #  主诊断入口
    # ══════════════════════════════════════════

    async def diagnose(self, session_id: str, ssh_manager: SSHManager) -> Dict[str, Any]:
        """
        对指定会话进行诊断

        Returns:
            包含 summary / diagnosis / recommendations / commands 的字典
            或包含 error 键的错误字典
        """
        session = ssh_manager.get_session(session_id)
        if not session:
            return {"error": "会话不存在或已断开"}

        # 1. 采集系统上下文
        context_data = await self._gather_context(session)

        # 检测 OS 类型
        try:
            sysinfo = session.get_system_info()
            os_type = sysinfo.get('os_type', 'unknown')
        except Exception:
            os_type = 'unknown'
        log.info(f"[GroqDiagnostic] 检测到 OS 类型: {os_type}")

        # 2. 构建 Prompt（根据 OS 类型）
        if os_type == 'windows':
            system_prompt = """
                你是一个资深 SRE 专家，擅长 Windows Server 运维和故障排查。
                请基于给定的系统信息，输出 JSON 格式的诊断结果。

                输出必须严格为 JSON，结构如下：
                {
                "summary": "一句话总结当前系统状态或问题",
                "diagnosis": "详细的诊断分析，包含可能的原因和影响",
                "recommendations": ["建议1", "建议2"],
                "commands": ["可执行的修复命令1", "可执行的修复命令2"]
                }

                要求：
                1. 基于事实诊断，不要臆造不存在的问题
                2. 如果系统整体健康，也要明确说明
                3. 命令必须使用 Windows 语法（PowerShell / cmd），不要输出 Linux 命令
                4. 不要输出 JSON 以外的任何内容
            """
        else:
            system_prompt = """
                你是一个资深 SRE 专家，擅长 Linux 系统运维和故障排查。
                请基于给定的系统信息，输出 JSON 格式的诊断结果。

                输出必须严格为 JSON，结构如下：
                {
                "summary": "一句话总结当前系统状态或问题",
                "diagnosis": "详细的诊断分析，包含可能的原因和影响",
                "recommendations": ["建议1", "建议2"],
                "commands": ["可执行的修复命令1", "可执行的修复命令2"]
                }

                要求：
                1. 基于事实诊断，不要臆造不存在的问题
                2. 如果系统整体健康，也要明确说明
                3. 命令要安全可执行，包含必要的参数说明
                4. 不要输出 JSON 以外的任何内容
            """

        user_prompt = (
            f"请分析以下{os_type}系统信息并给出诊断建议：\n\n{context_data}"
        )

        # 3. 调用 Groq API
        try:
            completion = await asyncio.wait_for(
                self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user",   "content": user_prompt},
                    ],
                    temperature=0.2,
                    max_tokens=1200,
                    response_format={"type": "json_object"},
                ),
                timeout=self.api_timeout,
            )

            response_text = completion.choices[0].message.content
            log.info(
                f"[GroqDiagnostic] API 调用成功，回复长度: {len(response_text)}"
            )

            result = json.loads(response_text)

            # 兜底补字段，防止前端渲染异常
            result.setdefault('summary',         '未返回摘要')
            result.setdefault('diagnosis',        '')
            result.setdefault('recommendations',  [])
            result.setdefault('commands',         [])

            # 🔧 归一化：AI 可能返回 list 而非 str
            def _ensure_str(v):
                if isinstance(v, list): return '\n'.join(str(x) for x in v)
                return str(v) if v else ''
            result['diagnosis']   = _ensure_str(result.get('diagnosis', ''))
            result['summary']     = _ensure_str(result.get('summary', ''))

            # 🔧 空 diagnosis 合成（AI 返回 "" 时 setdefault 不会介入）
            if not result['diagnosis'].strip():
                parts = []
                if result['summary'].strip():
                    parts.append(result['summary'].strip())
                recs = result.get('recommendations', [])
                if isinstance(recs, list) and recs:
                    parts.append('关键建议：' + '；'.join(recs[:3]))
                result['diagnosis'] = '\n'.join(parts) if parts else 'AI 未提供详细诊断，请根据摘要和建议手动分析。'

            if not isinstance(result['recommendations'], list):
                result['recommendations'] = [str(result['recommendations'])]
            if not isinstance(result['commands'], list):
                result['commands'] = [str(result['commands'])]

            return result

        except asyncio.TimeoutError:
            log.error("[GroqDiagnostic] Groq API 调用超时")
            return {"error": "AI 服务响应超时，请稍后重试"}

        except json.JSONDecodeError as e:
            log.error(f"[GroqDiagnostic] JSON 解析失败: {e}")
            return {"error": "AI 返回的数据格式错误，请稍后重试"}

        except Exception as e:
            log.error(f"[GroqDiagnostic] API 调用失败: {e}")
            return {"error": f"与 AI 服务通信失败: {str(e)}"}

    # ══════════════════════════════════════════
    #  系统信息采集
    # ══════════════════════════════════════════

    async def _gather_context(self, session) -> str:
        """
        采集系统信息：
        1. 先用 get_system_info() 拿结构化指标（速度快）
        2. 再补充少量高价值命令（根据 OS 类型选择）
        3. 整体受 total_budget 时间控制
        """
        start_time   = time.time()
        output_parts = []

        # ── 结构化指标（快速）──
        try:
            sysinfo = session.get_system_info()
            output_parts.append(
                "=== 结构化系统指标 ===\n" +
                json.dumps(sysinfo, ensure_ascii=False, indent=2, default=str)
            )
            os_type = sysinfo.get('os_type', 'unknown')
        except Exception as e:
            output_parts.append(f"=== 结构化系统指标 ===\n获取失败: {str(e)}")
            os_type = 'unknown'

        # ── 补充命令列表：(名称, 命令, 超时秒) ──
        if os_type == 'windows':
            commands = [
                ("进程列表",     "powershell \"Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 | Format-Table Name,CPU,PM,Id -AutoSize\"", 8),
                ("磁盘使用",     "powershell \"Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Format-Table DeviceID,@{N='SizeGB';E={[math]::Round($_.Size/1GB)}},@{N='FreeGB';E={[math]::Round($_.FreeSpace/1GB)}} -AutoSize\"", 5),
                ("网络监听",     "netstat -an | findstr LISTENING", 5),
                ("系统错误日志", "powershell \"Get-EventLog -LogName System -EntryType Error -Newest 20 | Format-Table TimeGenerated,Message -Wrap\" 2>nul || echo '事件日志不可用'", 8),
                ("服务状态",     "powershell \"Get-Service | Where-Object {$_.Status -eq 'Stopped'} | Select-Object -First 20 | Format-Table Name,DisplayName -AutoSize\"", 6),
            ]
        else:
            commands = [
                ("TOP摘要",        "top -b -n 1 | head -20",                         6),
                ("CPU占用TOP进程",  "ps aux --sort=-%cpu | head -10",                  5),
                ("内存占用TOP进程", "ps aux --sort=-%mem | head -10",                  5),
                ("磁盘使用详情",    "df -h",                                           5),
                ("网络监听端口",
                 "ss -tuln 2>/dev/null || netstat -tuln 2>/dev/null || echo 'N/A'",  5),
                ("最近系统错误",
                 ("journalctl -p 3 -n 20 --no-pager 2>/dev/null "
                  "|| tail -20 /var/log/syslog 2>/dev/null "
                  "|| echo '日志不可用'"),                                             6),
                ("内核日志摘要",
                 "dmesg 2>/dev/null | tail -20 || echo 'dmesg 不可用'",               5),
            ]

        for name, cmd, timeout in commands:
            elapsed = time.time() - start_time
            if elapsed > self.total_budget:
                output_parts.append(
                    f"=== {name} ===\n已跳过：达到采集时间预算 ({self.total_budget}s)"
                )
                continue

            try:
                stdout, stderr = session.execute_command(cmd, timeout=timeout)
                output = (stdout or '').strip() or (stderr or '').strip() or '(无输出)'

                # 单段输出截断，防止 prompt 过长
                if len(output) > 2000:
                    output = output[:2000] + "\n... [输出已截断]"

                output_parts.append(f"=== {name} ===\n{output}")

            except Exception as e:
                output_parts.append(f"=== {name} ===\n获取失败: {str(e)}")

            # 让出协程控制权
            await asyncio.sleep(0)

        total_elapsed = time.time() - start_time
        log.info(f"[GroqDiagnostic] 上下文采集完成，耗时 {total_elapsed:.1f}s，"
                 f"段数 {len(output_parts)}")

        return "\n\n".join(output_parts)


# ══════════════════════════════════════════
#  单例管理
# ══════════════════════════════════════════

_diagnostic_engine: Optional[GroqDiagnosticEngine] = None


def get_diagnostic_engine() -> GroqDiagnosticEngine:
    """获取诊断引擎单例（优先读取用户配置）"""
    global _diagnostic_engine

    if _diagnostic_engine is not None:
        return _diagnostic_engine

    api_key = ''
    base_url = ''
    model = ''

    # ✅ 从 ai_config 直接导入，无循环依赖
    try:
        from ai_config import get_effective_ai_config
        ai_cfg = get_effective_ai_config()
        api_key = ai_cfg.get('api_key', '')
        base_url = ai_cfg.get('base_url', '')
        model = ai_cfg.get('model', '')
    except (ImportError, AttributeError):
        pass

    # fallback 到环境变量 / config
    if not api_key:
        api_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not api_key:
        try:
            from config import config
            api_key = getattr(config, 'GROQ_API_KEY', '').strip()
        except ImportError:
            pass
    if not api_key:
        try:
            from dotenv import load_dotenv
            load_dotenv()
            api_key = os.environ.get("GROQ_API_KEY", "").strip()
        except ImportError:
            pass

    if not api_key:
        log.error("API Key 未设置，AI 诊断功能不可用")
        raise ValueError("API Key 未设置，请在设置中配置")

    _diagnostic_engine = GroqDiagnosticEngine(
        api_key=api_key,
        base_url=base_url or None,
        model=model or None,
    )
    log.info(f"[Diagnostic] 诊断引擎初始化成功，模型: {_diagnostic_engine.model}")
    return _diagnostic_engine