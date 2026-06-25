/**
 * ═══════════════════════════════════════════════════════════
 * 高危指令管理模块 (Dangerous Command Manager) v3.2
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
 * 可检测性改进：
 *   1. 弹窗状态通过 data-* 属性暴露，可被 DOM 查询
 *   2. 弹窗位置通过 CSS 变量暴露，可被 getComputedStyle 读取
 *   3. 弹窗生命周期事件通过 CustomEvent 派发，可被监听
 *   4. 弹窗 DOM 使用固定 ID 和 class，可被选择器定位
 *   5. 提供调试 API 供开发工具使用
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
    let _state = 'idle';                // idle | active | ready | closed
    let _lastCheck = null;              // { sessionId, cmd, rule, timestamp }
    let _activeSessionId = null;

    // ── CustomEvent 派发工具 ─────────────────────────────
    const _dispatch = (name, detail) => {
        window.dispatchEvent(new CustomEvent(name, {
            detail: Object.assign({ timestamp: Date.now() }, detail),
            bubbles: false
        }));
    };

    // ── data-* 状态同步 ──────────────────────────────────
    const _setState = (newState) => {
        _state = newState;
        const modal = document.getElementById('securityConfirmModal');
        if (modal) modal.setAttribute('data-dcm-state', newState);
    };

    // ── CSS 变量同步（位置信息）──────────────────────────
    const _syncCssVars = () => {
        const modal = document.getElementById('securityConfirmModal');
        if (!modal || _state === 'idle' || _state === 'closed') return;
        const rect = modal.getBoundingClientRect();
        const dialog = modal.querySelector('.modal-dialog');
        const dRect = dialog ? dialog.getBoundingClientRect() : rect;
        modal.style.setProperty('--dcm-modal-top',    rect.top + 'px');
        modal.style.setProperty('--dcm-modal-left',   rect.left + 'px');
        modal.style.setProperty('--dcm-modal-width',  rect.width + 'px');
        modal.style.setProperty('--dcm-modal-height', rect.height + 'px');
        modal.style.setProperty('--dcm-dialog-top',    dRect.top + 'px');
        modal.style.setProperty('--dcm-dialog-left',   dRect.left + 'px');
        modal.style.setProperty('--dcm-dialog-width',  dRect.width + 'px');
        modal.style.setProperty('--dcm-dialog-height', dRect.height + 'px');
    };

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

            switch (rule.level) {
                case LEVEL.CRITICAL:
                    DCM._blockCritical(sessionId, cmd, rule);
                    return true;

                case LEVEL.HIGH:
                    return DCM._showConfirm(sessionId, cmd, rule); // 确认→false(放行), 取消→true(拦截)

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
            _lastCheck = { sessionId, cmd, rule, timestamp: Date.now() };
            _dispatch('dcm:command:blocked', { sessionId, cmd, rule, level: 'critical' });
            const App = window.App;
            if (App) {
                App.toast('⛔ 极度危险命令已阻止: ' + rule.desc,
                    'error', 8000);
            }
            DCM.sendCtrlC(sessionId);
        },

        /** high：自定义安全确认弹窗（命令高亮 + 影响分析 + 倒计时后再确认） */
        _showConfirm(sessionId, cmd, rule) {
            const App = window.App;
            const lv = rule.level || 'high';

            _activeSessionId = sessionId;
            _lastCheck = { sessionId, cmd, rule, timestamp: Date.now() };

            // ── 降级：无 App 或 Modal ──
            if (!App || !document.getElementById('securityConfirmModal')) {
                if (confirm('⚠️ 高危命令:\n\n' + cmd + '\n\n风险: ' + rule.desc + '\n\n是否确认执行？')) {
                    if (App) App.toast('✅ 命令已确认并发送', 'success');
                    _dispatch('dcm:modal:confirm', { sessionId, cmd, rule });
                    return false;
                }
                if (App) App.toast('❌ 命令已取消', 'info');
                _dispatch('dcm:modal:cancel', { sessionId, cmd, rule });
                return true;
            }

            // ── 0. 设置 data-* 状态 ──
            const modal = document.getElementById('securityConfirmModal');
            _setState('active');

            // ── 1. 设置风险徽章 ──
            const badge = document.getElementById('secRiskBadge');
            const label = document.getElementById('secRiskLabel');
            if (badge && label) {
                const icons = { critical:'fa-biohazard', high:'fa-shield-virus', medium:'fa-exclamation-triangle' };
                const names = { critical:'严重威胁',  high:'高危操作',       medium:'中危提醒' };
                badge.className = 'sec-badge ' + lv;
                badge.querySelector('i').className = 'fas ' + (icons[lv] || icons.high);
                label.textContent = (names[lv] || names.high);
            }

            // 类别副标题
            const catEl = document.getElementById('secCategory');
            if (catEl) catEl.textContent = DCM._guessCategory(rule.desc);

            // ── 2. 命令高亮 ──
            const cmdText = document.getElementById('secCmdText');
            if (cmdText) cmdText.innerHTML = DCM._highlightCmd(cmd, rule);

            // ── 3. 描述 & 建议 ──
            const descEl = document.getElementById('secDescription');
            if (descEl) descEl.textContent = rule.desc;
            const suggEl = document.getElementById('secSuggestion');
            if (suggEl) suggEl.textContent = (rule.sugg || '请仔细核对命令后再执行');

            // ── 4. 影响分析（设置影响 data 属性）──
            const dmgGrid = document.getElementById('secDmgGrid');
            if (dmgGrid) {
                const impacts = DCM._analyzeImpact(cmd);
                dmgGrid.setAttribute('data-dcm-impacts', impacts.join(','));
                dmgGrid.innerHTML = DCM._IMPACT_DIMENSIONS.map(dim => {
                    const hit = impacts.indexOf(dim.id) >= 0;
                    return '<div class="sec-dmg-item ' + (hit ? 'active' : 'inactive') + '" data-impact="' + dim.id + '">' +
                        '<i class="fas ' + dim.icon + ' sec-dmg-icon"></i>' +
                        '<span>' + dim.label + '</span></div>';
                }).join('');
            }

            // ── 5. 动态副标题 ──
            const hdSub = document.getElementById('secHdSub');
            if (hdSub) hdSub.textContent = (lv === 'critical')
                ? '⚠ 此操作可能造成不可逆的严重损害，请谨慎决策'
                : '系统已拦截该命令，需二次确认后方可执行';

            // ── 6. 倒计时配置（秒）──
            const CD_SEC = lv === 'critical' ? 5 : 3;
            const cdBar  = document.getElementById('secCdFill');
            const cdNum  = document.getElementById('secCdNum');
            const cdText = document.getElementById('secCdText');
            const confirmBtn = document.getElementById('secConfirmBtn');
            const confirmLabel = document.getElementById('secConfirmLabel');
            const cmdPreview = document.getElementById('secCmdText');
            let cdTimer = null, cdLeft = CD_SEC, cdDone = false;

            // 倒计时区域暴露 data-* 属性
            const cdWrap = document.getElementById('secCountdown');
            if (cdWrap) {
                cdWrap.setAttribute('data-dcm-cd-total', String(CD_SEC));
                cdWrap.setAttribute('data-dcm-cd-left', String(CD_SEC));
            }

            const updateCdUI = (left) => {
                const pct = (left / CD_SEC) * 100;
                if (cdBar)  cdBar.style.width = pct + '%';
                if (cdNum)  cdNum.textContent = String(left);
                if (cdText) cdText.innerHTML = '请等待 <strong id="secCdNum">' + left + '</strong> 秒后再确认';
                if (cdWrap) cdWrap.setAttribute('data-dcm-cd-left', String(left));
                _dispatch('dcm:countdown:tick', { remaining: left, total: CD_SEC });
            };
            updateCdUI(CD_SEC);

            if (confirmBtn && confirmLabel) {
                confirmBtn.disabled = true;
                confirmBtn.setAttribute('data-dcm-ready', 'false');
                confirmLabel.textContent = '我了解风险，执行命令';
            }

            if (cmdPreview) {
                cmdPreview.setAttribute('data-dcm-cmd', cmd);
            }

            const startCd = () => {
                cdTimer = setInterval(() => {
                    cdLeft--;
                    updateCdUI(Math.max(cdLeft, 0));
                    if (cdLeft <= 0) {
                        clearInterval(cdTimer);
                        cdDone = true;
                        _setState('ready');
                        if (cdBar)  cdBar.style.width = '0%';
                        if (cdText) cdText.innerHTML = '<i class="fas fa-check-circle" style="color:#4caf50;"></i> 请再次确认后点击执行';
                        if (confirmBtn) {
                            confirmBtn.disabled = false;
                            confirmBtn.setAttribute('data-dcm-ready', 'true');
                            confirmBtn.focus();
                        }
                        if (cdWrap) cdWrap.setAttribute('data-dcm-cd-left', '0');
                        _dispatch('dcm:countdown:done', {});
                        _syncCssVars();
                    }
                }, 1000);
            };

            // ── 7. 事件绑定 & cleanup ──
            const cancelBtn = document.getElementById('secCancelBtn');
            const overlay   = modal ? modal.querySelector('.modal-overlay') : null;

            const cleanup = (reason) => {
                _setState('closed');
                if (cdTimer) clearInterval(cdTimer);
                DCM._clearTimer();
                if (confirmBtn) confirmBtn.replaceWith(confirmBtn.cloneNode(true));
                if (cancelBtn) cancelBtn.replaceWith(cancelBtn.cloneNode(true));
                if (overlay) overlay.replaceWith(overlay.cloneNode(true));
                App.closeModal('securityConfirmModal');
                // 清除 CSS 变量
                if (modal) {
                    modal.style.removeProperty('--dcm-modal-top');
                    modal.style.removeProperty('--dcm-modal-left');
                    modal.style.removeProperty('--dcm-modal-width');
                    modal.style.removeProperty('--dcm-modal-height');
                    modal.style.removeProperty('--dcm-dialog-top');
                    modal.style.removeProperty('--dcm-dialog-left');
                    modal.style.removeProperty('--dcm-dialog-width');
                    modal.style.removeProperty('--dcm-dialog-height');
                }
                _setState('idle');
                _activeSessionId = null;
                _dispatch('dcm:modal:close', { sessionId, cmd, rule, reason: reason || 'unknown' });
            };

            document.getElementById('secConfirmBtn').addEventListener('click', () => {
                if (!cdDone) return; // 倒计时未完成，忽略点击
                _dispatch('dcm:modal:confirm', { sessionId, cmd, rule });
                cleanup('confirm');
                App.socket.emit('terminal_input', {
                    session_id: sessionId,
                    data: cmd + '\r'
                });
                App.toast('✅ 命令已确认并发送', 'success');
            });

            document.getElementById('secCancelBtn').addEventListener('click', () => {
                _dispatch('dcm:modal:cancel', { sessionId, cmd, rule });
                cleanup('cancel');
                App.toast('❌ 命令已取消', 'info');
            });

            // 点击遮罩关闭（仅点击遮罩本身，不冒泡自弹窗内部）
            if (overlay) {
                overlay.addEventListener('click', (e) => {
                    if (e.target !== overlay) return;
                    _dispatch('dcm:modal:cancel', { sessionId, cmd, rule });
                    cleanup('overlay');
                    App.toast('❌ 命令已取消', 'info');
                });
            }

            // 60 秒超时（从打开弹窗起算）
            _confirmTimer = setTimeout(() => {
                _dispatch('dcm:modal:timeout', { sessionId, cmd, rule });
                cleanup('timeout');
                App.toast('⏰ 确认超时，请重新执行命令', 'warning');
            }, 60000);

            // ── 派发打开事件 & 打开弹窗（统一 modal 体系）──
            _dispatch('dcm:modal:open', { sessionId, cmd, rule, level: lv });
            App.openModal('securityConfirmModal');

            // 弹窗打开后同步 CSS 变量位置
            requestAnimationFrame(() => {
                _syncCssVars();
                // ResizeObserver：弹窗尺寸变化时自动更新 CSS 变量
                if (window._dcmResizeObserver) window._dcmResizeObserver.disconnect();
                if (modal && window.ResizeObserver) {
                    window._dcmResizeObserver = new ResizeObserver(() => _syncCssVars());
                    window._dcmResizeObserver.observe(modal);
                }
            });

            // 打开后启动倒计时
            setTimeout(startCd, 200);

            // 始终返回 true（拦截），由 Modal 的 confirm 按钮负责发送
            return true;
        },

        /** medium：Toast 警告后放行 */
        _warnAndPass(sessionId, cmd, rule) {
            _lastCheck = { sessionId, cmd, rule, timestamp: Date.now() };
            _dispatch('dcm:command:warned', { sessionId, cmd, rule, level: 'medium' });
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

        // ═══════════ 影响维度的静态定义 ═══════════
        _IMPACT_DIMENSIONS: [
            { id: 'data_loss',    icon: 'fa-database',     label: '数据丢失' },
            { id: 'permission',   icon: 'fa-key',          label: '权限变更' },
            { id: 'sys_crash',    icon: 'fa-power-off',    label: '系统崩溃/中断' },
            { id: 'svc_stop',     icon: 'fa-server',       label: '服务停止' },
            { id: 'disk_destroy', icon: 'fa-hdd',          label: '磁盘/分区损坏' },
            { id: 'sec_breach',   icon: 'fa-user-secret',  label: '安全漏洞' },
        ],

        /** 根据风险描述猜测操作类别 */
        _guessCategory(desc) {
            const keys = {
                '删除':   '文件与目录操作',
                '格式化': '磁盘/文件系统操作',
                '清空':   '数据销毁',
                '修改':   '权限与所有者变更',
                '关机':   '电源与系统控制',
                '重启':   '电源与系统控制',
                '停机':   '电源与系统控制',
                '分区':   '磁盘管理',
                '防火墙': '网络安全',
                '杀死':   '进程管理',
                '粉碎':   '数据销毁',
                '写入':   '磁盘写入',
                '关停':   '电源与系统控制',
                '覆盖':   '数据销毁',
                '删除所有': '定时任务管理',
                '清除':   '历史记录清理',
            };
            for (const k in keys) {
                if (desc.indexOf(k) >= 0) return keys[k];
            }
            return '系统命令';
        },

        /** 分析命令涉及的潜在影响维度 */
        _analyzeImpact(cmd) {
            const hits = [];
            // 数据丢失
            if (/\brm\b|shred|unlink|truncate|wipefs/.test(cmd))              hits.push('data_loss');
            // 磁盘/分区损坏
            if (/\bmkfs\b|mke2fs|fdisk|parted|dd\s+if=.*\/dev\//.test(cmd)  ||
                />\s*\/dev\/sd/.test(cmd))                                     hits.push('disk_destroy');
            // 权限变更
            if (/\bchmod\s+-R\s+777|chmod\s+777\b|chown\s+-R/.test(cmd))     hits.push('permission');
            // 系统崩溃/关机/重启
            if (/\bshutdown\b|reboot|halt|poweroff|init\s+[06]|kill\s+-9\b/.test(cmd)) hits.push('sys_crash');
            // 服务停止
            if (/\bsystemctl\s+(stop|disable)\b/.test(cmd))                    hits.push('svc_stop');
            // 安全漏洞（防火墙清空等）
            if (/\biptables\s+-F|iptables\s+-X/.test(cmd))                     hits.push('sec_breach');

            // 兜底：无匹配则至少显示数据丢失风险
            return hits.length ? hits : ['data_loss'];
        },

        /** 命令高亮：将规则 pattern 匹配到的片段包裹 <span class="cmd-hl"> */
        _highlightCmd(cmd, rule) {
            if (!rule.pat) { return DCM._escapeHtml(cmd); }
            const escaped = DCM._escapeHtml(cmd);
            try {
                // 用规则的 pat 去匹配原始 cmd，拿到匹配区间
                const m = cmd.match(rule.pat);
                if (!m || typeof m.index !== 'number') return escaped;

                const start = m.index;
                const end   = start + m[0].length;
                // 需要计算 HTML 转义后的偏移映射（简单方案：纯 ASCII 命令通常 1:1）
                let htmlStart = start;
                let htmlEnd   = end;
                // 计算转义引入的偏移（仅 '&' '<' '>' 会导致偏移）
                for (let i = 0; i < start; i++) {
                    if (cmd[i] === '&') htmlStart += 4; // &amp;
                    else if (cmd[i] === '<') htmlStart += 3; // &lt;
                    else if (cmd[i] === '>') htmlStart += 3; // &gt;
                }
                htmlEnd = htmlStart;
                for (let i = start; i < end; i++) {
                    const ch = cmd[i];
                    htmlEnd += (ch === '&') ? 5 : (ch === '<' || ch === '>') ? 4 : 1;
                }

                return escaped.substring(0, htmlStart) +
                    '<span class="cmd-hl">' + escaped.substring(htmlStart, htmlEnd) + '</span>' +
                    escaped.substring(htmlEnd);
            } catch(e) {
                return escaped;
            }
        },

        /** HTML 转义 */
        _escapeHtml(str) {
            const div = document.createElement('div');
            div.appendChild(document.createTextNode(str));
            return div.innerHTML;
        },
    };

    // ═══════════════════════════════════════════════════════
    //  挂载到全局
    // ═══════════════════════════════════════════════════════
    window.DangerousCommandManager = DCM;

    // ═══════════════════════════════════════════════════════
    //  调试 API (window.DCM_DEBUG)
    // ═══════════════════════════════════════════════════════
    window.DCM_DEBUG = {
        /** 获取当前弹窗状态: idle | active | ready | closed */
        getState() {
            var modalEl = document.getElementById('securityConfirmModal');
            return {
                state: _state,
                activeSessionId: _activeSessionId,
                lastCheck: _lastCheck ? { ..._lastCheck } : null,
                modalVisible: modalEl ? modalEl.classList.contains('visible') : false
            };
        },

        /** 一键诊断：打印所有可检测性信息到控制台 */
        inspect() {
            console.group('%c🔍 DCM v3.2 诊断报告', 'font-size:14px;font-weight:bold;color:#00bcd4;');
            console.log('%c📌 状态 (data-dcm-state):', 'font-weight:bold;', _state);
            console.log('%c📌 活跃会话:', 'font-weight:bold;', _activeSessionId || '(无)');
            console.log('%c📌 弹窗可见:', 'font-weight:bold;',
                document.getElementById('securityConfirmModal')?.classList.contains('visible'));

            console.group('%c🗂 data-* 属性', 'font-weight:bold;');
            var m = document.getElementById('securityConfirmModal');
            var cb = document.getElementById('secConfirmBtn');
            var cw = document.getElementById('secCountdown');
            var dg = document.getElementById('secDmgGrid');
            var cp = document.getElementById('secCmdText');
            console.table({
                'data-dcm-state':  m ? m.getAttribute('data-dcm-state') : '(无元素)',
                'data-dcm-ready':  cb ? cb.getAttribute('data-dcm-ready') : '(无元素)',
                'data-dcm-cd-total': cw ? cw.getAttribute('data-dcm-cd-total') : '(无元素)',
                'data-dcm-cd-left':  cw ? cw.getAttribute('data-dcm-cd-left') : '(无元素)',
                'data-dcm-impacts':  dg ? dg.getAttribute('data-dcm-impacts') : '(无元素)',
                'data-dcm-cmd':      cp ? cp.getAttribute('data-dcm-cmd') : '(无元素)',
            });
            console.groupEnd();

            console.group('%c📍 CSS 变量位置', 'font-weight:bold;');
            var css = this.getCssVars();
            if (css) {
                console.table({
                    '--dcm-modal-top':     css.top,
                    '--dcm-modal-left':    css.left,
                    '--dcm-modal-width':   css.width,
                    '--dcm-modal-height':  css.height,
                    '--dcm-dialog-top':    css.dialogTop,
                    '--dcm-dialog-left':   css.dialogLeft,
                    '--dcm-dialog-width':  css.dialogWidth,
                    '--dcm-dialog-height': css.dialogHeight,
                });
            } else {
                console.log('  (弹窗未打开，无位置信息)');
            }
            console.groupEnd();

            console.group('%c📋 最近检测', 'font-weight:bold;');
            var lc = this.getLastCheck();
            if (lc) {
                console.log('  命令:', lc.cmd);
                console.log('  会话:', lc.sessionId);
                console.log('  等级:', lc.rule.level);
                console.log('  描述:', lc.rule.desc);
                console.log('  时间:', new Date(lc.timestamp).toLocaleTimeString());
            } else {
                console.log('  (无)');
            }
            console.groupEnd();

            console.groupEnd();
        },

        /** 获取最近一次检测的命令 */
        getLastCheck() {
            return _lastCheck ? { ..._lastCheck } : null;
        },

        /** 获取所有规则 */
        getRules() {
            return DCM.getRules();
        },

        /** 纯检测命令（不触发任何动作） */
        testCommand(cmd) {
            const rule = DCM._matchRule(cmd);
            if (!rule) return { safe: true, matched: null };
            return {
                safe: false,
                matched: {
                    level: rule.level,
                    description: rule.desc,
                    suggestion: rule.sugg
                },
                impacts: DCM._analyzeImpact(cmd),
                category: DCM._guessCategory(rule.desc),
                highlighted: DCM._highlightCmd(cmd, rule)
            };
        },

        /** 强制关闭弹窗 */
        forceClose() {
            const modal = document.getElementById('securityConfirmModal');
            if (modal && _state !== 'idle' && _state !== 'closed') {
                DCM._clearTimer();
                _setState('closed');
                if (window.App) window.App.closeModal('securityConfirmModal');
                _setState('idle');
                _activeSessionId = null;
                _dispatch('dcm:modal:close', { reason: 'force' });
            }
        },

        /** 注册自定义事件监听器 */
        on(eventName, handler) {
            window.addEventListener(eventName, handler);
        },

        /** 取消注册自定义事件监听器 */
        off(eventName, handler) {
            window.removeEventListener(eventName, handler);
        },

        /** 列出所有可用事件名称 */
        listEvents() {
            return [
                'dcm:modal:open',       // 弹窗打开时
                'dcm:modal:confirm',    // 用户确认执行时
                'dcm:modal:cancel',     // 用户取消时
                'dcm:modal:close',      // 弹窗关闭时（所有关闭路径：confirm/cancel/timeout/overlay/force）
                'dcm:modal:timeout',    // 60秒超时关闭时
                'dcm:countdown:tick',   // 倒计时每秒触发（detail.remaining, detail.total）
                'dcm:countdown:done',   // 倒计时结束，确认按钮变为可用
                'dcm:command:blocked',  // Critical 级别命令被阻止
                'dcm:command:warned',   // Medium 级别命令触发警告
            ];
        },

        /** CSS 变量快照：获取弹窗当前 CSS 变量值 */
        getCssVars() {
            const modal = document.getElementById('securityConfirmModal');
            if (!modal) return null;
            const style = getComputedStyle(modal);
            return {
                top: style.getPropertyValue('--dcm-modal-top'),
                left: style.getPropertyValue('--dcm-modal-left'),
                width: style.getPropertyValue('--dcm-modal-width'),
                height: style.getPropertyValue('--dcm-modal-height'),
                dialogTop: style.getPropertyValue('--dcm-dialog-top'),
                dialogLeft: style.getPropertyValue('--dcm-dialog-left'),
                dialogWidth: style.getPropertyValue('--dcm-dialog-width'),
                dialogHeight: style.getPropertyValue('--dcm-dialog-height'),
            };
        },

        /** DOM data-* 属性快照 */
        getDataAttrs() {
            const modal = document.getElementById('securityConfirmModal');
            const confirmBtn = document.getElementById('secConfirmBtn');
            const cdWrap = document.getElementById('secCountdown');
            const dmgGrid = document.getElementById('secDmgGrid');
            const cmdPreview = document.getElementById('secCmdText');
            return {
                modalState: modal ? modal.getAttribute('data-dcm-state') : null,
                confirmReady: confirmBtn ? confirmBtn.getAttribute('data-dcm-ready') : null,
                cdTotal: cdWrap ? cdWrap.getAttribute('data-dcm-cd-total') : null,
                cdLeft: cdWrap ? cdWrap.getAttribute('data-dcm-cd-left') : null,
                impacts: dmgGrid ? dmgGrid.getAttribute('data-dcm-impacts') : null,
                cmdText: cmdPreview ? cmdPreview.getAttribute('data-dcm-cmd') : null,
            };
        },
    };

})();
