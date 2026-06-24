/**
 * ═══════════════════════════════════════════════════════════
 * 高危指令管理模块 (Dangerous Command Manager) v2
 * ═══════════════════════════════════════════════════════════
 *
 * 纯本地规则引擎，零 API 依赖，实时同步响应：
 *   critical → 直接阻止执行 + 发送 Ctrl+C + 错误提示
 *   high     → 弹出安全确认弹窗（确认/取消/60s超时）
 *   medium   → Toast 警告提示 + 放行执行
 *
 * 与 app.js 的集成点：
 *   term.onData 逐字缓冲 → Enter 时调用 DCM.checkAndBlock(sessionId, cmd)
 *   → 返回 true 表示命令被拦截（内部已处理 confirm/block/toast）
 *   → 返回 false 表示安全，调用方自行发送 \r
 *
 * 规则排列规则：specific（critical）→ generic（medium），先匹配先生效
 *
 * 依赖：window.App (toast, socket, openModal, closeModal)
 *      DOM: #securityConfirmModal 弹窗元素
 */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════
    //  风险等级常量
    // ═══════════════════════════════════════════════════════
    const LEVEL = {
        CRITICAL: 'critical',   // 直接阻止，不可绕过
        HIGH:     'high',       // 弹窗二次确认
        MEDIUM:   'medium',     // Toast 提醒后放行
    };

    // ═══════════════════════════════════════════════════════
    //  完整规则表（按优先级排列：critical > high > medium）
    //  每条规则: { level, pattern, description, suggestion }
    // ═══════════════════════════════════════════════════════

    // ── CRITICAL：极度危险，直接阻止 ─────────────────────
    const R_CRIT = LEVEL.CRITICAL;
    const CRITICAL_RULES = [
        // 根目录递归删除
        { pat: /\brm\s+-rf\s+\//,            desc: '递归强制删除根目录',                          sugg: '请指定明确的子目录路径' },
        { pat: /\brm\s+-rf\s+\/\*/,           desc: '删除根目录下所有内容',                        sugg: '请指定明确的子目录路径' },
        { pat: /\brm\s+-[rR][fF]\s+~?\/[\s;$|&]/, desc: '删除根目录或家目录',                   sugg: '请指定明确的子目录路径' },
        // 磁盘清零 / 随机写入
        { pat: /\bdd\s+if=\/dev\/(zero|random|urandom)/, desc: '向磁盘写入零字节/随机数据',       sugg: '请确认目标设备正确' },
        // 格式化文件系统
        { pat: /\bmkfs\b/,                    desc: '格式化文件系统，将清空所有数据',               sugg: '请先备份数据' },
        { pat: /\bmke2fs\b/,                  desc: '格式化 ext 文件系统，将清空所有数据',          sugg: '请先备份数据' },
        // 直接写入磁盘设备
        { pat: />\s*\/dev\/sd[a-z]/,          desc: '重定向写入磁盘设备',                          sugg: '极度危险，请勿执行' },
        { pat: /\bcat\s+\/dev\/null\s*>\s*\/dev\/sd/, desc: '清空磁盘设备',                        sugg: '极度危险，请勿执行' },
        // Fork 炸弹
        { pat: /:\(\)\{.*\}.*:/,              desc: 'Fork 炸弹，将导致系统崩溃',                   sugg: '这是恶意代码，请勿执行' },
        // 杀 init / 杀所有进程
        { pat: /\bkill\s+-9\s+1\b/,           desc: '杀死 init(PID=1)进程，导致系统崩溃',          sugg: '请勿执行此操作' },
        { pat: /\bkill\s+-9\s+-1\b/,          desc: '杀死所有进程，导致系统崩溃',                  sugg: '请勿执行此操作' },
    ];

    // ── HIGH：高危操作，弹窗确认 ─────────────────────────
    const R_HIGH = LEVEL.HIGH;
    const HIGH_RULES = [
        // 递归删除
        { pat: /\brm\s+-rf\s+/,               desc: '递归强制删除目录，可能造成数据丢失',           sugg: '请确认目标目录无误，建议先 ls 查看' },
        { pat: /\brm\s+-[rR][fF]\s+/,          desc: '递归强制删除目录，可能造成数据丢失',           sugg: '请确认目标目录无误' },
        { pat: /\brm\s+-[rR]\s+/,              desc: '递归删除目录，可能造成数据丢失',               sugg: '请确认目标目录无误' },
        { pat: /\brm\s+-[fF]\s+/,              desc: '强制删除文件，跳过确认提示',                   sugg: '请确认要删除的文件' },
        // 安全粉碎
        { pat: /\bshred\b/,                    desc: '安全粉碎文件（多次覆写后删除），不可恢复',      sugg: '请先备份重要文件' },
        // 权限变更
        { pat: /\bchmod\s+-R\s+777/,           desc: '递归赋予所有权限(777)，存在严重安全风险',      sugg: '请使用最小必要权限' },
        { pat: /\bchmod\s+777\s+\//,           desc: '给根目录赋予全部权限',                         sugg: '这会导致严重安全漏洞' },
        { pat: /\bchown\s+-R\s+\S+\s+\//,      desc: '递归修改根目录所有者',                         sugg: '请指定具体子目录' },
        { pat: /\bchown\s+-R\s+root:root\s+\//, desc: '递归修改根目录所有者为 root',                 sugg: '请指定具体子目录' },
        // 移入黑洞
        { pat: /\bmv\s+\S+\s+\/dev\/null/,     desc: '将文件移入黑洞(/dev/null)，数据不可恢复',       sugg: '请使用 rm 并先备份' },
        // 磁盘分区
        { pat: /\bfdisk\b/,                    desc: '磁盘分区操作，可能导致数据丢失',                 sugg: '请先备份重要数据，确认目标磁盘' },
        { pat: /\bparted\b/,                   desc: '磁盘分区操作，可能导致数据丢失',                 sugg: '请先备份重要数据，确认目标磁盘' },
        // 关机/重启
        { pat: /\bshutdown\b/,                 desc: '关机操作，将中断所有服务',                      sugg: '请确认非生产环境' },
        { pat: /\breboot\b/,                   desc: '重启操作，将中断所有服务',                      sugg: '请确认非生产环境' },
        { pat: /\bhalt\b/,                     desc: '停机操作，将中断所有服务',                      sugg: '请确认非生产环境' },
        { pat: /\bpoweroff\b/,                 desc: '关机操作，将中断所有服务',                      sugg: '请确认非生产环境' },
        { pat: /\binit\s+[06]\b/,              desc: '切换运行级别，可能关机/重启',                   sugg: '请确认非生产环境' },
        // 防火墙清空
        { pat: /\biptables\s+-F/,              desc: '清空防火墙规则，暴露所有端口',                   sugg: '请确认有其他安全措施后再操作' },
        { pat: /\biptables\s+-X/,              desc: '删除自定义防火墙链',                            sugg: '请确认有其他安全措施后再操作' },
        // 覆盖写入磁盘
        { pat: /\bdd\s+if=/,                   desc: '磁盘写入操作(if=)，可能覆盖磁盘数据',           sugg: '请确认输入/输出设备正确' },
        // 命令行语句 rm -rf ...; ...（管道后跟高危删除）
    ];

    // ── MEDIUM：中危操作，Toast 提醒后放行 ───────────────
    const R_MED = LEVEL.MEDIUM;
    const MEDIUM_RULES = [
        // 普通删除
        { pat: /\brm\s+/,                      desc: '删除文件，不可恢复',                            sugg: '请确认要删除的文件' },
        { pat: /\brmdir\b/,                    desc: '删除空目录',                                    sugg: '请确认目录为空且不再需要' },
        { pat: /\bunlink\b/,                   desc: '删除文件链接',                                  sugg: '请确认不再需要此文件' },
        { pat: /\btruncate\s+-s\s+0/,          desc: '清空文件内容',                                  sugg: '请先备份文件' },
        { pat: /\bwipefs\b/,                   desc: '擦除文件系统签名',                              sugg: '可能导致数据丢失，请确认设备' },
        // 创建交换分区
        { pat: /\bmkswap\b/,                   desc: '创建交换分区',                                  sugg: '请确认目标设备正确' },
        // 进程管理
        { pat: /\bkill\s+-9\b/,                desc: '强制终止进程(kill -9)',                         sugg: '请先尝试 kill（不带-9），确认进程可安全终止' },
        // 系统服务控制
        { pat: /\bsystemctl\s+stop\s+/,        desc: '停止系统服务',                                  sugg: '请确认服务可以安全停止，非关键依赖' },
        { pat: /\bsystemctl\s+disable/,         desc: '禁用系统服务（开机不启动）',                     sugg: '请确认服务非关键依赖' },
        // 用户/密码管理
        { pat: /\bpasswd\b/,                   desc: '修改用户密码',                                   sugg: '请记录新密码并妥善保管' },
        { pat: /\buserdel\s+-r/,               desc: '删除用户及主目录',                              sugg: '请先备份用户数据' },
        { pat: /\buserdel\b/,                  desc: '删除用户',                                      sugg: '请确认用户不再需要' },
        // 定时任务
        { pat: /\bcrontab\s+-r\b/,             desc: '删除所有 crontab 定时任务',                      sugg: '请先备份 crontab -l > backup.cron' },
        // 清除历史
        { pat: /\bhistory\s+-c\b/,             desc: '清除命令历史记录',                               sugg: '此操作不可恢复' },
        // 文件系统修复
        { pat: /\bfsck\b/,                     desc: '文件系统检查与修复',                             sugg: '建议先卸载目标分区' },
        // 递归修改权限（非 777）
        { pat: /\bchmod\s+-R\b/,               desc: '递归修改权限',                                  sugg: '请确认目录范围正确' },
        { pat: /\bchown\s+-R\b/,               desc: '递归修改所有者',                                sugg: '请确认目录范围正确' },
    ];

    // ═══════════════════════════════════════════════════════
    //  合并所有规则，critical 优先 → high → medium
    // ═══════════════════════════════════════════════════════
    const ALL_RULES = [
        ...CRITICAL_RULES.map(r => ({ ...r, level: R_CRIT })),
        ...HIGH_RULES.map(r     => ({ ...r, level: R_HIGH })),
        ...MEDIUM_RULES.map(r   => ({ ...r, level: R_MED })),
    ];

    // ═══════════════════════════════════════════════════════
    //  内部状态
    // ═══════════════════════════════════════════════════════
    let _confirmTimer = null;

    // ═══════════════════════════════════════════════════════
    //  公共 API
    // ═══════════════════════════════════════════════════════

    const DCM = {

        // ── 核心方法：检测并拦截 ──────────────────────────

        /**
         * 检查命令风险等级并根据等级执行对应操作（同步，无 API 依赖）
         *
         * @param {string} sessionId - 终端会话 ID
         * @param {string} cmd       - 完整命令行
         * @returns {boolean} true=已拦截（内部已处理），false=安全可执行
         */
        checkAndBlock(sessionId, cmd) {
            if (!cmd || cmd.length < 2) return false;

            const rule = DCM._matchRule(cmd);
            if (!rule) return false;

            console.log('[DCM v2] 命中规则 → level:' + rule.level +
                ' desc:' + rule.desc + ' cmd:' + cmd);

            switch (rule.level) {
                case LEVEL.CRITICAL:
                    DCM._blockCritical(sessionId, cmd, rule);
                    return true;

                case LEVEL.HIGH:
                    DCM._showConfirm(sessionId, cmd, rule);
                    return true;

                case LEVEL.MEDIUM:
                    DCM._warnAndPass(sessionId, cmd, rule);
                    return false; // Toast 警告但仍然放行，调用方应发送 \r

                default:
                    return false;
            }
        },

        /**
         * 纯检测：命令是否匹配任何规则（保留兼容旧 API）
         * @param {string} cmd
         * @returns {boolean}
         */
        isPotentiallyRisky(cmd) {
            return !!DCM._matchRule(cmd);
        },

        /**
         * 获取匹配到的规则详情
         * @param {string} cmd
         * @returns {object|null} {level, desc, sugg} 或 null
         */
        getMatchedRule(cmd) {
            const r = DCM._matchRule(cmd);
            return r ? { level: r.level, description: r.desc, suggestion: r.sugg } : null;
        },

        // ── 终端控制 ──────────────────────────────────────

        sendEnter(sessionId) {
            const App = window.App;
            if (App && App.socket) {
                App.socket.emit('terminal_input', { session_id: sessionId, data: '\r' });
            }
        },

        sendCtrlC(sessionId) {
            const App = window.App;
            if (App && App.socket) {
                App.socket.emit('terminal_input', { session_id: sessionId, data: '\x03' });
            }
        },

        // ── 规则查询 ──────────────────────────────────────

        getRules() {
            return ALL_RULES.map(r => ({ ...r }));
        },

        getLevels() {
            return { ...LEVEL };
        },

        // ═══════════════════════════════════════════════════
        //  内部方法
        // ═══════════════════════════════════════════════════

        /** 按优先级匹配第一个命中的规则 */
        _matchRule(cmd) {
            for (const r of ALL_RULES) {
                if (r.pat.test(cmd)) return r;
            }
            return null;
        },

        /** critical：阻止执行，发送 Ctrl+C 取消当前行 */
        _blockCritical(sessionId, cmd, rule) {
            const App = window.App;
            if (App) {
                App.toast('⛔ 极度危险命令已阻止: ' + rule.desc,
                    'error', 8000);
            }
            DCM.sendCtrlC(sessionId);
        },

        /** high：弹出安全确认弹窗 */
        _showConfirm(sessionId, cmd, rule) {
            const App = window.App;
            const modal = document.getElementById('securityConfirmModal');

            // 降级：模态框不存在时用浏览器原生 confirm
            if (!modal || !App) {
                const msg = '⚠️ 高危命令:\n\n' + cmd +
                    '\n\n风险: ' + rule.desc +
                    '\n建议: ' + (rule.sugg || '请仔细核对命令后再执行') +
                    '\n\n是否确认执行？';
                if (confirm(msg)) {
                    DCM.sendEnter(sessionId);
                } else {
                    DCM.sendCtrlC(sessionId);
                }
                return;
            }

            // 填充弹窗内容
            const badge  = document.getElementById('secRiskBadge');
            const label  = document.getElementById('secRiskLabel');
            const cmdEl  = document.getElementById('secCmdText');
            const descEl = document.getElementById('secDescription');
            const suggEl = document.getElementById('secSuggestion');

            if (badge)  badge.className = 'security-risk-badge high';
            if (label)  label.textContent = 'HIGH';
            if (cmdEl)  cmdEl.textContent = cmd || '';
            if (descEl) descEl.textContent = rule.desc || '-';
            if (suggEl) suggEl.textContent = rule.sugg || '请仔细核对命令后再执行';

            // 清理旧事件并绑定新事件
            const cleanup = () => {
                const cb = document.getElementById('secConfirmBtn');
                const cc = document.getElementById('secCancelBtn');
                const ov = modal.querySelector('.modal-overlay');
                if (cb) cb.replaceWith(cb.cloneNode(true));
                if (cc) cc.replaceWith(cc.cloneNode(true));
                if (ov) ov.replaceWith(ov.cloneNode(true));
                App.closeModal('securityConfirmModal');
                DCM._clearTimer();
            };

            document.getElementById('secConfirmBtn').addEventListener('click', () => {
                cleanup();
                DCM.sendEnter(sessionId);
                App.toast('✅ 命令已确认并发送', 'success');
            });

            document.getElementById('secCancelBtn').addEventListener('click', () => {
                cleanup();
                DCM.sendCtrlC(sessionId);
                App.toast('❌ 命令已取消', 'info');
            });

            // 60 秒超时自动取消
            _confirmTimer = setTimeout(() => {
                cleanup();
                App.toast('⏰ 确认超时，请重新输入命令', 'warning');
            }, 60000);

            App.openModal('securityConfirmModal');
        },

        /** medium：Toast 警告后放行 */
        _warnAndPass(sessionId, cmd, rule) {
            const App = window.App;
            if (App) {
                App.toast(
                    '⚠️ 中危操作: ' + rule.desc +
                    ' — ' + (rule.sugg || '请确认是否安全'),
                    'warning', 5000
                );
            }
            // 不在此发送 \r，由调用方统一发送
        },

        _clearTimer() {
            if (_confirmTimer) {
                clearTimeout(_confirmTimer);
                _confirmTimer = null;
            }
        },
    };

    // ═══════════════════════════════════════════════════════
    //  挂载到全局
    // ═══════════════════════════════════════════════════════
    window.DangerousCommandManager = DCM;

    // 🔧 初始化日志：确认 v2 规则引擎已加载
    if (typeof console !== 'undefined') {
        console.log('[DCM v2] 高危命令规则引擎已就绪 | 规则总数: ' + ALL_RULES.length +
            ' (critical:' + CRITICAL_RULES.length +
            ' high:' + HIGH_RULES.length +
            ' medium:' + MEDIUM_RULES.length + ')');
    }

})();
