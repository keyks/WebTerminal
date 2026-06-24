// frontend/js/ai_assistant.js
/**
 * AI 运维助手前端控制器 v2.1
 * 修复：
 * 1. 切换 Tab 不重新渲染，保留聊天记录
 * 2. 对话历史从后端数据库加载
 * 3. 知识库自动加载
 */
const AIAssistant = {

    currentSessionId: null,
    currentChatId:    null,
    _initialized:     new Set(),   // 记录已初始化的 sessionId，避免重复渲染

    // ══════════════════════════════════════════
    //  初始化（switchPanelTab 'ai-diagnose' 时调用）
    // ══════════════════════════════════════════

    init(sessionId) {
        this.currentSessionId = sessionId;
        this.currentChatId    = `chat_${sessionId}`;

        // ✅ 只在第一次初始化时渲染面板，后续切换不重建
        if (!this._initialized.has(sessionId)) {
            this._initialized.add(sessionId);
            this._renderPanel(sessionId);
        } else {
            // 切回时只更新当前 sessionId，不重新渲染
            this.currentSessionId = sessionId;
            this.currentChatId    = `chat_${sessionId}`;
        }
    },

    // ══════════════════════════════════════════
    //  面板销毁（closeSession 时调用）
    // ══════════════════════════════════════════

    destroy(sessionId) {
        this._initialized.delete(sessionId);
    },

    // ══════════════════════════════════════════
    //  渲染主面板（只调用一次）
    // ══════════════════════════════════════════

    _renderPanel(sessionId) {
        const container = document.getElementById(`ai-diagnose-${sessionId}`);
        if (!container) return;

        container.innerHTML = `
            <div style="display:flex;flex-direction:column;height:100%;
                        background:var(--bg-primary);">

                <!-- 顶部 Sub-Tab -->
                <div style="display:flex;gap:0;border-bottom:1px solid var(--border-color);
                            background:var(--bg-secondary);flex-shrink:0;overflow-x:auto;">
                    ${[
                        ['chat',      'fa-comments',        '智能助手'],
                        ['history',   'fa-history',         '历史记录'],
                        ['diagnose',  'fa-stethoscope',     'AI 诊断'],
                        ['predict',   'fa-chart-line',      '容量预测'],
                        ['security',  'fa-shield-alt',      '安全扫描'],
                        ['knowledge', 'fa-book',            '知识库'],
                        ['topology',  'fa-project-diagram', '拓扑图'],
                    ].map(([tab, icon, label]) => `
                        <div class="ai-sub-tab" data-tab="${tab}"
                             onclick="AIAssistant.switchTab('${sessionId}','${tab}')"
                             style="padding:10px 14px;cursor:pointer;font-size:12px;
                                    display:flex;align-items:center;gap:5px;
                                    color:var(--text-secondary);
                                    border-bottom:2px solid transparent;
                                    transition:all 0.2s;white-space:nowrap;
                                    flex-shrink:0;">
                            <i class="fas ${icon}"></i>
                            <span>${label}</span>
                        </div>
                    `).join('')}
                </div>

                <!-- 内容区 -->
                <div style="flex:1;overflow:hidden;position:relative;">

                    <!-- 智能助手 -->
                    <div class="ai-tab-content"
                         id="ai-tab-chat-${sessionId}"
                         style="display:none;flex-direction:column;height:100%;">
                        ${this._renderChatPanel(sessionId)}
                    </div>

                    <!-- 历史记录 -->
                    <div class="ai-tab-content"
                         id="ai-tab-history-${sessionId}"
                         style="display:none;height:100%;overflow-y:auto;padding:20px;">
                        ${this._renderHistoryPanel(sessionId)}
                    </div>

                    <!-- AI 诊断 -->
                    <div class="ai-tab-content"
                         id="ai-tab-diagnose-${sessionId}"
                         style="display:none;height:100%;overflow-y:auto;padding:20px;">
                        ${this._renderDiagnosePanel(sessionId)}
                    </div>

                    <!-- 容量预测 -->
                    <div class="ai-tab-content"
                         id="ai-tab-predict-${sessionId}"
                         style="display:none;height:100%;overflow-y:auto;padding:20px;">
                        ${this._renderPredictPanel(sessionId)}
                    </div>

                    <!-- 安全扫描 -->
                    <div class="ai-tab-content"
                         id="ai-tab-security-${sessionId}"
                         style="display:none;height:100%;overflow-y:auto;padding:20px;">
                        ${this._renderSecurityPanel(sessionId)}
                    </div>

                    <!-- 知识库 -->
                    <div class="ai-tab-content"
                         id="ai-tab-knowledge-${sessionId}"
                         style="display:none;height:100%;overflow-y:auto;padding:20px;">
                        ${this._renderKnowledgePanel(sessionId)}
                    </div>

                    <!-- 拓扑图 -->
                    <div class="ai-tab-content"
                         id="ai-tab-topology-${sessionId}"
                         style="display:none;height:100%;overflow-y:auto;padding:20px;">
                        ${this._renderTopologyPanel(sessionId)}
                    </div>

                </div>
            </div>
        `;

        // ✅ 初始化完成后激活默认 Tab，并加载数据
        this.switchTab(sessionId, 'chat');
        this._loadChatHistory(sessionId);
    },

    // ══════════════════════════════════════════
    //  Tab 切换
    // ══════════════════════════════════════════

    switchTab(sessionId, tab) {
        const container = document.getElementById(`ai-diagnose-${sessionId}`);
        if (!container) return;

        container.querySelectorAll('.ai-sub-tab').forEach(el => {
            const active = el.dataset.tab === tab;
            el.style.color        = active ? 'var(--accent-color)' : 'var(--text-secondary)';
            el.style.borderBottom = active
                ? '2px solid var(--accent-color)'
                : '2px solid transparent';
            el.style.background   = active ? 'var(--bg-hover)' : 'transparent';
        });

        container.querySelectorAll('.ai-tab-content').forEach(el => {
            el.style.display = 'none';
        });

        const target = document.getElementById(`ai-tab-${tab}-${sessionId}`);
        if (!target) return;

        target.style.display = (tab === 'chat') ? 'flex' : 'block';

        // ✅ 按需触发各 Tab 的数据加载
        if (tab === 'history')   this._loadHistoryList(sessionId);
        if (tab === 'knowledge') this.loadKB(sessionId, '');
    },

    // ══════════════════════════════════════════
    //  模块一：聊天面板
    // ══════════════════════════════════════════

    _renderChatPanel(sessionId) {
        return `
            <div id="chatMessages-${sessionId}"
                 style="flex:1;overflow-y:auto;padding:16px;
                        display:flex;flex-direction:column;gap:12px;">
                <div style="text-align:center;color:var(--text-secondary);
                            padding:40px 20px;">
                    <i class="fas fa-robot"
                       style="font-size:40px;display:block;margin-bottom:12px;
                              color:var(--accent-color);opacity:0.6;"></i>
                    <div style="font-size:0.95rem;font-weight:500;
                                color:var(--text-bright);margin-bottom:8px;">
                        AI 运维助手
                    </div>
                    <div style="font-size:0.82rem;line-height:1.8;
                                color:var(--text-secondary);">
                        你好！你可以用自然语言向我提问，例如：<br>
                        <span style="color:var(--accent-color);">
                            "检查 Nginx 是否正常运行"
                        </span><br>
                        <span style="color:var(--accent-color);">
                            "为什么内存占用这么高？"
                        </span>
                    </div>
                </div>
            </div>

            <!-- 快捷提示 -->
            <div style="padding:8px 16px;display:flex;gap:6px;flex-wrap:wrap;
                        border-top:1px solid var(--border-color);flex-shrink:0;
                        background:var(--bg-secondary);">
                ${[
                    '检查系统健康状态',
                    '内存占用最高的进程',
                    '检查磁盘空间',
                    '查看最近的系统错误',
                ].map(q => `
                    <span onclick="AIAssistant.sendQuick('${sessionId}',
                                   ${JSON.stringify(q)})"
                          style="font-size:11px;padding:3px 10px;border-radius:12px;
                                 cursor:pointer;background:var(--bg-tertiary);
                                 color:var(--text-secondary);
                                 border:1px solid var(--border-color);
                                 transition:all 0.2s;user-select:none;"
                          onmouseenter="this.style.borderColor='var(--accent-color)';
                                        this.style.color='var(--accent-color)'"
                          onmouseleave="this.style.borderColor='var(--border-color)';
                                        this.style.color='var(--text-secondary)'">
                        ${q}
                    </span>
                `).join('')}
            </div>

            <!-- 输入区 -->
            <div style="padding:12px 16px;border-top:1px solid var(--border-color);
                        background:var(--bg-secondary);flex-shrink:0;">
                <div style="display:flex;gap:8px;align-items:flex-end;">
                    <textarea id="chatInput-${sessionId}"
                              placeholder="输入运维问题... (Enter 发送，Shift+Enter 换行)"
                              rows="2"
                              onkeydown="AIAssistant.onChatKeydown(event,'${sessionId}')"
                              style="flex:1;padding:10px 14px;
                                     border:1px solid var(--border-color);
                                     border-radius:8px;background:var(--bg-tertiary);
                                     color:var(--text-primary);font-size:13px;
                                     resize:none;outline:none;font-family:inherit;
                                     line-height:1.5;transition:border-color 0.2s;"
                              onfocus="this.style.borderColor='var(--accent-color)'"
                              onblur="this.style.borderColor='var(--border-color)'">
                    </textarea>
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        <button onclick="AIAssistant.sendMessage('${sessionId}')"
                                id="chatSendBtn-${sessionId}"
                                class="btn btn-primary btn-sm"
                                style="height:38px;width:70px;">
                            <i class="fas fa-paper-plane"></i> 发送
                        </button>
                        <button onclick="AIAssistant.clearChat('${sessionId}')"
                                class="btn btn-sm"
                                style="height:30px;width:70px;font-size:11px;"
                                title="清空对话">
                            <i class="fas fa-trash"></i> 清空
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    // ══════════════════════════════════════════
    //  从后端加载聊天历史
    // ══════════════════════════════════════════

    async _loadChatHistory(sessionId) {
        const chatId = `chat_${sessionId}`;
        try {
            const res  = await fetch(
                `/api/ai/chat/history?chat_id=${encodeURIComponent(chatId)}&limit=100`,
                { headers: App.authHeaders() }
            );
            const data = await res.json();
            if (data.status !== 'ok' || !data.data?.length) return;

            const msgs = document.getElementById(`chatMessages-${sessionId}`);
            if (!msgs) return;

            // 清空欢迎语
            msgs.innerHTML = '';

            // 渲染历史消息
            for (const msg of data.data) {
                if (msg.role === 'system') continue;
                this._appendMessage(msgs, msg.role, msg.content, [], msg.created_at);
            }

            msgs.scrollTop = msgs.scrollHeight;

        } catch (e) {
            console.warn('[AI] 加载历史失败:', e);
        }
    },

    // ══════════════════════════════════════════
    //  发送消息
    // ══════════════════════════════════════════

    async sendMessage(sessionId) {
        const input   = document.getElementById(`chatInput-${sessionId}`);
        const btnEl   = document.getElementById(`chatSendBtn-${sessionId}`);
        const msgs    = document.getElementById(`chatMessages-${sessionId}`);
        const message = (input?.value || '').trim();
        if (!message || !msgs) return;

        input.value = '';

        // 显示用户消息
        this._appendMessage(msgs, 'user', message);

        // 显示加载
        const loadingId = `loading-${Date.now()}`;
        msgs.insertAdjacentHTML('beforeend', `
            <div id="${loadingId}"
                 style="display:flex;gap:10px;align-items:flex-start;">
                <div style="width:32px;height:32px;border-radius:50%;flex-shrink:0;
                            background:var(--bg-tertiary);display:flex;
                            align-items:center;justify-content:center;">
                    <i class="fas fa-robot"
                       style="color:var(--accent-color);font-size:14px;"></i>
                </div>
                <div style="background:var(--bg-secondary);
                            border:1px solid var(--border-color);
                            border-radius:12px;padding:12px 16px;max-width:80%;">
                    <i class="fas fa-spinner fa-spin"
                       style="color:var(--accent-color);"></i>
                    <span style="color:var(--text-secondary);font-size:13px;
                                 margin-left:8px;">AI 正在思考...</span>
                </div>
            </div>
        `);
        msgs.scrollTop = msgs.scrollHeight;

        if (btnEl) {
            btnEl.disabled  = true;
            btnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        }

        try {
            const res = await fetch('/api/ai/chat', {
                method:  'POST',
                headers: App.authHeaders(),
                body:    JSON.stringify({
                    session_id: sessionId,
                    chat_id:    `chat_${sessionId}`,
                    message,
                }),
            });
            const data = await res.json();

            document.getElementById(loadingId)?.remove();

            if (data.status === 'ok') {
                // ✅ 消息已由后端写入数据库，前端直接渲染
                this._appendMessage(
                    msgs, 'assistant', data.reply, data.commands
                );
            } else {
                this._appendMessage(msgs, 'error', data.message || '请求失败');
            }

        } catch (e) {
            document.getElementById(loadingId)?.remove();
            this._appendMessage(msgs, 'error', '网络错误: ' + e.message);
        } finally {
            if (btnEl) {
                btnEl.disabled  = false;
                btnEl.innerHTML = '<i class="fas fa-paper-plane"></i> 发送';
            }
            msgs.scrollTop = msgs.scrollHeight;
        }
    },

    // ══════════════════════════════════════════
    //  渲染单条消息（✅ 切换 Tab 后不会丢失）
    // ══════════════════════════════════════════

    _appendMessage(container, role, content, commands = [], timestamp = null) {
        const isUser  = role === 'user';
        const isError = role === 'error';

        const avatarIcon  = isUser  ? 'fa-user'
                          : isError ? 'fa-exclamation-circle'
                          : 'fa-robot';
        const avatarColor = isUser  ? 'var(--success-color)'
                          : isError ? 'var(--danger-color)'
                          : 'var(--accent-color)';
        const bgColor     = isUser  ? 'rgba(79,195,247,0.08)'
                          : 'var(--bg-secondary)';
        const align       = isUser  ? 'flex-direction:row-reverse;' : '';

        // 简易 Markdown 渲染
        let html = App.escapeHtml(content)
            .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
                `<pre style="background:var(--bg-tertiary);padding:10px;
                             border-radius:6px;font-family:Consolas,monospace;
                             font-size:12px;white-space:pre-wrap;
                             margin:8px 0;overflow-x:auto;">${code}</pre>`
            )
            .replace(/`([^`]+)`/g, (_, c) =>
                `<code style="background:var(--bg-tertiary);padding:1px 5px;
                              border-radius:3px;font-family:Consolas,monospace;
                              font-size:12px;">${c}</code>`
            )
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');

        // 命令块
        let commandsHtml = '';
        if (commands?.length) {
            const riskColors = {
                safe:     'var(--success-color)',
                low:      'var(--info-color)',
                medium:   'var(--warning-color)',
                high:     'var(--danger-color)',
                critical: '#ff0000',
            };
            commandsHtml = `
                <div style="margin-top:12px;border-top:1px solid var(--border-color);
                            padding-top:10px;">
                    <div style="font-size:11px;color:var(--text-secondary);
                                margin-bottom:6px;">
                        <i class="fas fa-terminal"></i> 相关命令
                    </div>
                    ${commands.map(c => {
                        const risk  = c.risk || {};
                        const level = risk.level || 'low';
                        const color = riskColors[level] || 'var(--text-secondary)';
                        const cmdJs = JSON.stringify(c.command);
                        return `
                            <div style="display:flex;align-items:center;gap:8px;
                                        background:var(--bg-tertiary);padding:8px 12px;
                                        border-radius:6px;margin-bottom:4px;
                                        border-left:3px solid ${color};">
                                <code style="flex:1;color:var(--text-bright);
                                             font-family:Consolas,monospace;
                                             font-size:12px;word-break:break-all;">
                                    ${App.escapeHtml(c.command)}
                                </code>
                                <span style="font-size:10px;color:${color};
                                             flex-shrink:0;">
                                    ${level !== 'safe' ? level.toUpperCase() : ''}
                                </span>
                                ${level !== 'critical' ? `
                                <button class="btn btn-sm btn-primary"
                                        onclick="AIAssistant.executeCommand(
                                            ${JSON.stringify(this.currentSessionId)},
                                            ${cmdJs},
                                            '${level}')"
                                        style="font-size:11px;padding:3px 8px;
                                               flex-shrink:0;">
                                    执行
                                </button>` : `
                                <span style="font-size:11px;color:var(--danger-color);
                                             flex-shrink:0;">禁止</span>`}
                            </div>
                        `;
                    }).join('')}
                </div>`;
        }

        // 时间戳
        const timeHtml = timestamp
            ? `<div style="font-size:10px;color:var(--text-secondary);
                           margin-top:4px;text-align:${isUser ? 'right' : 'left'};">
                   ${timestamp.replace('T', ' ').slice(0, 19)}
               </div>`
            : '';

        container.insertAdjacentHTML('beforeend', `
            <div style="display:flex;gap:10px;align-items:flex-start;${align}">
                <div style="width:32px;height:32px;border-radius:50%;flex-shrink:0;
                            background:var(--bg-tertiary);display:flex;
                            align-items:center;justify-content:center;">
                    <i class="fas ${avatarIcon}"
                       style="color:${avatarColor};font-size:14px;"></i>
                </div>
                <div style="max-width:80%;">
                    <div style="background:${bgColor};
                                border:1px solid var(--border-color);
                                border-radius:12px;padding:12px 16px;
                                font-size:13px;line-height:1.7;
                                color:var(--text-primary);">
                        ${html}
                        ${commandsHtml}
                    </div>
                    ${timeHtml}
                </div>
            </div>
        `);
    },

    executeCommand(sessionId, command, riskLevel) {
        if (riskLevel === 'critical') {
            App.toast('此命令被标记为极度危险，已阻止执行', 'error');
            return;
        }
        if (riskLevel !== 'safe' && riskLevel !== 'low') {
            if (!confirm(`⚠️ ${riskLevel.toUpperCase()} 风险命令，确认执行？\n\n${command}`)) {
                return;
            }
        }
        App.socket.emit('terminal_input', {
            session_id: sessionId,
            data:       command + '\n',
        });
        // ✅ 切换到终端后，聊天内容仍然保留
        const panel   = document.getElementById(`panel-${sessionId}`);
        const termTab = panel?.querySelector('.panel-tab[data-tab="terminal"]');
        if (termTab) App.switchPanelTab(sessionId, 'terminal', termTab);
        App.toast('命令已发送到终端', 'success');
    },

    sendQuick(sessionId, text) {
        const input = document.getElementById(`chatInput-${sessionId}`);
        if (input) {
            input.value = text;
            this.sendMessage(sessionId);
        }
    },

    onChatKeydown(event, sessionId) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this.sendMessage(sessionId);
        }
    },

    async clearChat(sessionId) {
        if (!confirm('确认清空当前会话的所有对话记录？')) return;
        const chatId = `chat_${sessionId}`;
        await fetch('/api/ai/chat/clear', {
            method:  'POST',
            headers: App.authHeaders(),
            body:    JSON.stringify({ chat_id: chatId }),
        });
        const msgs = document.getElementById(`chatMessages-${sessionId}`);
        if (msgs) {
            msgs.innerHTML = `
                <div style="text-align:center;color:var(--text-secondary);
                            padding:40px;">
                    对话已清空
                </div>`;
        }
        App.toast('对话已清空', 'success');
    },

    // ══════════════════════════════════════════
    //  历史记录面板
    // ══════════════════════════════════════════

    _renderHistoryPanel(sessionId) {
        return `
            <div style="max-width:900px;margin:0 auto;width:100%;">
                <div style="display:flex;align-items:center;
                            justify-content:space-between;margin-bottom:20px;">
                    <div>
                        <h3 style="color:var(--text-bright);margin:0;">
                            <i class="fas fa-history"
                               style="color:var(--accent-color);"></i>
                            历史对话记录
                        </h3>
                        <p style="color:var(--text-secondary);font-size:12px;
                                  margin:4px 0 0;">
                            所有对话记录保存在本地数据库中
                        </p>
                    </div>
                    <div style="display:flex;gap:8px;">
                        <input type="date" id="historyDateFilter-${sessionId}"
                               onchange="AIAssistant._loadHistoryList('${sessionId}')"
                               style="padding:6px 10px;border:1px solid var(--border-color);
                                      background:var(--bg-tertiary);color:var(--text-primary);
                                      border-radius:6px;font-size:13px;">
                        <button class="btn btn-sm"
                                onclick="AIAssistant._loadHistoryList('${sessionId}')">
                            <i class="fas fa-sync-alt"></i> 刷新
                        </button>
                    </div>
                </div>
                <div id="historyList-${sessionId}">
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:40px;">
                        <i class="fas fa-spinner fa-spin"></i> 加载中...
                    </div>
                </div>
            </div>
        `;
    },

    async _loadHistoryList(sessionId) {
        const div = document.getElementById(`historyList-${sessionId}`);
        if (!div) return;

        try {
            // 获取所有历史会话列表
            const res  = await fetch('/api/ai/chat/sessions',
                { headers: App.authHeaders() });
            const data = await res.json();

            if (!data.data?.length) {
                div.innerHTML = `
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:60px;background:var(--bg-secondary);
                                border-radius:12px;border:1px dashed var(--border-color);">
                        <i class="fas fa-comment-slash"
                           style="font-size:36px;display:block;
                                  margin-bottom:12px;opacity:0.3;"></i>
                        暂无历史对话记录
                    </div>`;
                return;
            }

            div.innerHTML = data.data.map(session => `
                <div style="background:var(--bg-secondary);
                            border:1px solid var(--border-color);
                            border-radius:8px;padding:14px 16px;
                            margin-bottom:8px;cursor:pointer;
                            transition:border-color 0.2s;"
                     onclick="AIAssistant._loadSessionDetail(
                         '${sessionId}', '${session.chat_id}')"
                     onmouseenter="this.style.borderColor='var(--accent-color)'"
                     onmouseleave="this.style.borderColor='var(--border-color)'">
                    <div style="display:flex;justify-content:space-between;
                                align-items:center;">
                        <div>
                            <div style="font-size:13px;font-weight:500;
                                        color:var(--text-bright);">
                                <i class="fas fa-comments"
                                   style="color:var(--accent-color);
                                          margin-right:6px;"></i>
                                ${App.escapeHtml(session.chat_id)}
                            </div>
                            <div style="font-size:12px;color:var(--text-secondary);
                                        margin-top:4px;">
                                ${session.message_count} 条消息 ·
                                开始于 ${(session.started_at || '').slice(0, 16)}
                            </div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-size:11px;color:var(--text-secondary);">
                                最后活跃
                            </div>
                            <div style="font-size:12px;color:var(--text-primary);">
                                ${(session.last_active || '').slice(0, 16)}
                            </div>
                        </div>
                    </div>
                </div>
            `).join('');

        } catch (e) {
            div.innerHTML = `
                <div style="color:var(--danger-color);padding:20px;">
                    加载失败: ${App.escapeHtml(e.message)}
                </div>`;
        }
    },

    async _loadSessionDetail(sessionId, chatId) {
        const div = document.getElementById(`historyList-${sessionId}`);
        if (!div) return;

        try {
            const res  = await fetch(
                `/api/ai/chat/history?chat_id=${encodeURIComponent(chatId)}&limit=200`,
                { headers: App.authHeaders() }
            );
            const data = await res.json();
            const msgs = data.data || [];

            div.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;
                            margin-bottom:16px;">
                    <button class="btn btn-sm"
                            onclick="AIAssistant._loadHistoryList('${sessionId}')">
                        <i class="fas fa-arrow-left"></i> 返回列表
                    </button>
                    <span style="font-size:13px;color:var(--text-secondary);">
                        ${App.escapeHtml(chatId)} · ${msgs.length} 条消息
                    </span>
                </div>
                <div style="display:flex;flex-direction:column;gap:10px;">
                    ${msgs.filter(m => m.role !== 'system').map(m => {
                        const isUser = m.role === 'user';
                        const bgColor = isUser
                            ? 'rgba(79,195,247,0.08)'
                            : 'var(--bg-secondary)';
                        const align = isUser
                            ? 'margin-left:auto;text-align:right;'
                            : '';
                        return `
                            <div style="max-width:80%;${align}">
                                <div style="font-size:10px;
                                            color:var(--text-secondary);
                                            margin-bottom:3px;">
                                    ${isUser ? '👤 你' : '🤖 AI'} ·
                                    ${(m.created_at || '').slice(0, 16)}
                                </div>
                                <div style="background:${bgColor};
                                            border:1px solid var(--border-color);
                                            border-radius:10px;padding:10px 14px;
                                            font-size:13px;line-height:1.6;
                                            color:var(--text-primary);
                                            white-space:pre-wrap;word-break:break-word;">
                                    ${App.escapeHtml(m.content)}
                                </div>
                            </div>`;
                    }).join('')}
                </div>
            `;

        } catch (e) {
            div.innerHTML = `
                <div style="color:var(--danger-color);padding:20px;">
                    加载失败: ${App.escapeHtml(e.message)}
                </div>`;
        }
    },

    // ══════════════════════════════════════════
    //  AI 诊断面板
    // ══════════════════════════════════════════

    _renderDiagnosePanel(sessionId) {
        return `
            <div style="max-width:900px;margin:0 auto;width:100%;">
                <div style="display:flex;align-items:center;gap:12px;
                            margin-bottom:20px;">
                    <i class="fas fa-stethoscope"
                       style="font-size:24px;color:var(--accent-color);"></i>
                    <div>
                        <h3 style="color:var(--text-bright);margin:0;">AI 系统诊断</h3>
                        <p style="color:var(--text-secondary);font-size:12px;
                                  margin:2px 0 0;">
                            全面采集系统状态，AI 分析并给出修复建议
                        </p>
                    </div>
                </div>
                <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
                    <button class="btn btn-primary"
                            id="diagnoseBtn-${sessionId}"
                            onclick="AIAssistant.runDiagnose('${sessionId}')">
                        <i class="fas fa-play"></i> 开始诊断
                    </button>
                    <button class="btn"
                            id="diagnoseExportBtn-${sessionId}"
                            onclick="AIAssistant.exportDiagnose('${sessionId}')"
                            disabled>
                        <i class="fas fa-file-export"></i> 导出报告
                    </button>
                    <button class="btn"
                            id="diagnoseSaveBtn-${sessionId}"
                            onclick="AIAssistant.saveDiagnoseToKB('${sessionId}')"
                            style="display:none;">
                        <i class="fas fa-book"></i> 存入知识库
                    </button>
                </div>
                <div id="diagnoseResult-${sessionId}">
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:60px;background:var(--bg-secondary);
                                border-radius:12px;
                                border:1px dashed var(--border-color);">
                        <i class="fas fa-stethoscope"
                           style="font-size:40px;display:block;
                                  margin-bottom:12px;opacity:0.3;"></i>
                        点击「开始诊断」让 AI 分析系统状态
                    </div>
                </div>
            </div>
        `;
    },

    async runDiagnose(sessionId) {
        const btn       = document.getElementById(`diagnoseBtn-${sessionId}`);
        const resultDiv = document.getElementById(`diagnoseResult-${sessionId}`);
        if (!resultDiv) return;

        if (btn) {
            btn.disabled  = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 诊断中...';
        }

        resultDiv.innerHTML = `
            <div style="text-align:center;padding:60px;
                        background:var(--bg-secondary);border-radius:12px;
                        border:1px dashed var(--border-color);">
                <i class="fas fa-spinner fa-spin"
                   style="font-size:36px;display:block;margin-bottom:16px;
                          color:var(--accent-color);"></i>
                <p>AI 正在采集系统信息并分析...</p>
                <p style="font-size:12px;color:var(--text-secondary);margin-top:4px;">
                    预计 15~30 秒
                </p>
            </div>`;

        try {
            const res = await fetch('/api/ai/diagnose', {
                method:  'POST',
                headers: App.authHeaders(),
                body:    JSON.stringify({ session_id: sessionId }),
            });
            const ct = res.headers.get('content-type') || '';
            if (!ct.includes('application/json')) {
                throw new Error(`HTTP ${res.status} 非 JSON 响应`);
            }
            const data = await res.json();
            if (data.status !== 'ok') throw new Error(data.message);

            const report = data.data;
            this._lastDiagnoseReport  = report;
            this._lastDiagnoseSession = sessionId;

            this._renderDiagnoseReport(sessionId, report, resultDiv);

            const exportBtn = document.getElementById(`diagnoseExportBtn-${sessionId}`);
            const saveBtn   = document.getElementById(`diagnoseSaveBtn-${sessionId}`);
            if (exportBtn) exportBtn.disabled    = false;
            if (saveBtn)   saveBtn.style.display = '';

            App.toast('AI 诊断完成', 'success');

        } catch (e) {
            resultDiv.innerHTML = `
                <div style="background:var(--alert-critical-bg);border-radius:12px;
                            padding:24px;border:1px solid var(--danger-color);">
                    <i class="fas fa-exclamation-circle"
                       style="color:var(--danger-color);font-size:20px;
                              margin-right:10px;"></i>
                    <strong style="color:var(--danger-color);">诊断失败</strong>
                    <p style="color:var(--text-secondary);margin-top:8px;
                              font-size:13px;">
                        ${App.escapeHtml(e.message)}
                    </p>
                    <button class="btn btn-sm"
                            onclick="AIAssistant.runDiagnose('${sessionId}')"
                            style="margin-top:12px;">
                        <i class="fas fa-redo"></i> 重试
                    </button>
                </div>`;
            App.toast('诊断失败: ' + e.message, 'error');
        } finally {
            if (btn) {
                btn.disabled  = false;
                btn.innerHTML = '<i class="fas fa-stethoscope"></i> 开始诊断';
            }
        }
    },

    _renderDiagnoseReport(sessionId, report, container) {
        const cmdsHtml = (report.commands || []).map((cmd, i) => `
            <div style="display:flex;align-items:center;gap:10px;
                        background:var(--bg-tertiary);padding:10px 14px;
                        border-radius:8px;margin-bottom:6px;
                        border-left:3px solid var(--success-color);">
                <span style="color:var(--text-secondary);font-size:11px;
                             min-width:20px;">#${i + 1}</span>
                <code style="flex:1;color:var(--text-bright);
                             font-family:Consolas,monospace;font-size:12px;
                             word-break:break-all;">
                    ${App.escapeHtml(cmd)}
                </code>
                <button class="btn btn-sm btn-primary"
                        onclick="AIAssistant.executeCommand(
                            '${sessionId}',
                            ${JSON.stringify(cmd)},
                            'low')"
                        style="flex-shrink:0;">
                    <i class="fas fa-play"></i>
                </button>
            </div>
        `).join('');

        const recsHtml = (report.recommendations || []).map(r => `
            <li style="margin-bottom:4px;">${App.escapeHtml(r)}</li>
        `).join('');

        container.innerHTML = `
            <div style="background:var(--bg-secondary);border-radius:12px;
                        padding:24px;border:1px solid var(--border-color);">
                <div style="display:flex;align-items:center;gap:12px;
                            margin-bottom:20px;padding-bottom:16px;
                            border-bottom:1px solid var(--border-color);">
                    <div style="width:44px;height:44px;border-radius:12px;
                                flex-shrink:0;background:rgba(79,195,247,0.15);
                                display:flex;align-items:center;justify-content:center;">
                        <i class="fas fa-robot"
                           style="color:var(--accent-color);font-size:20px;"></i>
                    </div>
                    <div style="flex:1;">
                        <div style="font-size:1rem;font-weight:600;
                                    color:var(--text-bright);">
                            ${App.escapeHtml(report.summary || '诊断完成')}
                        </div>
                        <div style="font-size:11px;color:var(--text-secondary);
                                    margin-top:3px;">
                            ${new Date().toLocaleString()}
                        </div>
                    </div>
                </div>
                <div style="margin-bottom:16px;">
                    <h4 style="color:var(--text-bright);margin-bottom:8px;
                               font-size:14px;">
                        <i class="fas fa-search"
                           style="color:var(--info-color);"></i> 诊断详情
                    </h4>
                    <div style="background:var(--bg-tertiary);padding:14px;
                                border-radius:8px;font-size:13px;line-height:1.8;
                                white-space:pre-wrap;color:var(--text-primary);">
                        ${App.escapeHtml(report.diagnosis || '无详细信息')}
                    </div>
                </div>
                ${recsHtml ? `
                <div style="margin-bottom:16px;">
                    <h4 style="color:var(--text-bright);margin-bottom:8px;
                               font-size:14px;">
                        <i class="fas fa-lightbulb"
                           style="color:var(--warning-color);"></i> 修复建议
                    </h4>
                    <ul style="padding-left:20px;color:var(--text-primary);
                               font-size:13px;line-height:1.8;">
                        ${recsHtml}
                    </ul>
                </div>` : ''}
                ${cmdsHtml ? `
                <div>
                    <h4 style="color:var(--text-bright);margin-bottom:8px;
                               font-size:14px;">
                        <i class="fas fa-terminal"
                           style="color:var(--success-color);"></i> 建议执行
                    </h4>
                    ${cmdsHtml}
                    <div style="font-size:11px;color:var(--text-secondary);
                                margin-top:6px;">
                        <i class="fas fa-shield-alt"></i> 执行前请确认命令安全性
                    </div>
                </div>` : ''}
            </div>
        `;
    },

    exportDiagnose(sessionId) {
        const report = this._lastDiagnoseReport;
        if (!report) { App.toast('请先执行诊断', 'warning'); return; }
        const session = App.sessions[sessionId] || {};
        const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        let md = `# AI 诊断报告\n\n`;
        md += `**主机**: ${session.connName || sessionId}\n`;
        md += `**时间**: ${new Date().toLocaleString()}\n\n---\n\n`;
        md += `## 诊断摘要\n\n${report.summary}\n\n`;
        md += `## 详细分析\n\n${report.diagnosis}\n\n`;
        if (report.recommendations?.length) {
            md += `## 修复建议\n\n`;
            report.recommendations.forEach((r, i) => { md += `${i+1}. ${r}\n`; });
        }
        if (report.commands?.length) {
            md += `\n## 建议命令\n\n`;
            report.commands.forEach((c, i) => { md += `${i+1}. \`${c}\`\n`; });
        }
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = `诊断报告_${ts}.md`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        App.toast('报告已导出', 'success');
    },

    async saveDiagnoseToKB(sessionId) {
        const report  = this._lastDiagnoseReport;
        const session = App.sessions[sessionId] || {};
        if (!report) return;
        const content = [
            `## 诊断摘要\n${report.summary}`,
            `## 详细分析\n${report.diagnosis}`,
            report.recommendations?.length
                ? `## 修复建议\n${report.recommendations.join('\n')}`
                : '',
            report.commands?.length
                ? `## 修复命令\n${report.commands.map(c => '`'+c+'`').join('\n')}`
                : '',
        ].filter(Boolean).join('\n\n');
        try {
            const res = await fetch('/api/ai/knowledge', {
                method:  'POST',
                headers: App.authHeaders(),
                body:    JSON.stringify({
                    title:    `诊断 - ${session.connName || sessionId} - ${new Date().toLocaleDateString()}`,
                    content,
                    tags:     ['诊断', session.connName || sessionId],
                    category: 'fault',
                }),
            });
            const data = await res.json();
            if (data.status === 'ok') App.toast('已保存到知识库', 'success');
        } catch (e) {
            App.toast('保存失败: ' + e.message, 'error');
        }
    },

    // ══════════════════════════════════════════
    //  容量预测面板
    // ══════════════════════════════════════════

    _renderPredictPanel(sessionId) {
        return `
            <div style="max-width:900px;margin:0 auto;width:100%;">
                <div style="display:flex;align-items:center;gap:12px;
                            margin-bottom:20px;">
                    <i class="fas fa-chart-line"
                       style="font-size:24px;color:var(--accent-color);"></i>
                    <div>
                        <h3 style="color:var(--text-bright);margin:0;">容量预测</h3>
                        <p style="color:var(--text-secondary);font-size:12px;
                                  margin:2px 0 0;">
                            AI 分析资源使用趋势，预测未来风险
                        </p>
                    </div>
                </div>
                <button class="btn btn-primary"
                        id="predictBtn-${sessionId}"
                        onclick="AIAssistant.runPredict('${sessionId}')">
                    <i class="fas fa-chart-line"></i> 开始预测
                </button>
                <div id="predictResult-${sessionId}" style="margin-top:20px;">
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:60px;background:var(--bg-secondary);
                                border-radius:12px;
                                border:1px dashed var(--border-color);">
                        <i class="fas fa-chart-line"
                           style="font-size:40px;display:block;
                                  margin-bottom:12px;opacity:0.3;"></i>
                        点击「开始预测」分析资源趋势
                    </div>
                </div>
            </div>
        `;
    },

    async runPredict(sessionId) {
        const btn = document.getElementById(`predictBtn-${sessionId}`);
        const div = document.getElementById(`predictResult-${sessionId}`);
        if (!div) return;
        if (btn) {
            btn.disabled  = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 分析中...';
        }
        div.innerHTML = `<div style="text-align:center;padding:40px;
            color:var(--text-secondary);">
            <i class="fas fa-spinner fa-spin"
               style="font-size:30px;display:block;margin-bottom:12px;
                      color:var(--accent-color);"></i>
            AI 正在分析资源趋势...
        </div>`;
        try {
            const res  = await fetch('/api/ai/predict', {
                method:  'POST',
                headers: App.authHeaders(),
                body:    JSON.stringify({ session_id: sessionId }),
            });
            const data = await res.json();
            if (data.status !== 'ok') throw new Error(data.message);
            const result     = data.data;
            const scoreColor = result.overall_health >= 80
                ? 'var(--success-color)'
                : result.overall_health >= 50
                ? 'var(--warning-color)'
                : 'var(--danger-color)';
            div.innerHTML = `
                <div style="background:var(--bg-secondary);border-radius:12px;
                            padding:24px;border:1px solid var(--border-color);">
                    <div style="display:flex;align-items:center;gap:16px;
                                margin-bottom:24px;padding-bottom:16px;
                                border-bottom:1px solid var(--border-color);">
                        <div style="width:64px;height:64px;border-radius:50%;
                                    flex-shrink:0;background:var(--bg-tertiary);
                                    display:flex;flex-direction:column;
                                    align-items:center;justify-content:center;
                                    border:3px solid ${scoreColor};">
                            <span style="font-size:20px;font-weight:700;
                                         color:${scoreColor};">
                                ${result.overall_health || 0}
                            </span>
                            <span style="font-size:10px;color:var(--text-secondary);">
                                健康分
                            </span>
                        </div>
                        <div>
                            <h4 style="color:var(--text-bright);margin:0 0 4px;">
                                资源健康评估
                            </h4>
                            ${(result.priority_actions || []).map(a =>
                                `<div style="font-size:12px;
                                             color:var(--warning-color);">
                                    ⚡ ${App.escapeHtml(a)}
                                </div>`
                            ).join('')}
                        </div>
                    </div>
                    ${(result.predictions || []).map(p => {
                        const rc = p.risk_level === 'critical'
                            ? 'var(--danger-color)'
                            : p.risk_level === 'high'
                            ? 'var(--warning-color)'
                            : p.risk_level === 'medium'
                            ? 'var(--info-color)'
                            : 'var(--success-color)';
                        const daysText = p.estimated_full_days > 0
                            ? `预计 <strong style="color:${rc}">
                                   ${p.estimated_full_days} 天
                               </strong>后耗尽`
                            : '暂无耗尽风险';
                        return `
                            <div style="margin-bottom:14px;padding:14px;
                                        background:var(--bg-tertiary);
                                        border-radius:8px;
                                        border-left:4px solid ${rc};">
                                <div style="display:flex;justify-content:space-between;
                                            align-items:center;margin-bottom:6px;">
                                    <strong style="color:var(--text-bright);">
                                        ${App.escapeHtml(p.resource)}
                                    </strong>
                                    <span style="font-size:12px;color:${rc};">
                                        ${(p.risk_level || '').toUpperCase()}
                                    </span>
                                </div>
                                <div style="font-size:13px;color:var(--text-secondary);
                                            margin-bottom:4px;">
                                    当前: ${p.current_usage} | ${daysText}
                                </div>
                                <div style="font-size:12px;color:var(--text-secondary);">
                                    趋势: ${App.escapeHtml(p.trend || '-')}
                                </div>
                                ${p.suggestions?.length ? `
                                <ul style="margin:8px 0 0;padding-left:18px;
                                           font-size:12px;color:var(--text-primary);">
                                    ${p.suggestions.map(s =>
                                        `<li>${App.escapeHtml(s)}</li>`
                                    ).join('')}
                                </ul>` : ''}
                            </div>`;
                    }).join('')}
                </div>`;
            App.toast('容量预测完成', 'success');
        } catch (e) {
            div.innerHTML = `
                <div style="background:var(--alert-critical-bg);padding:20px;
                            border-radius:12px;border:1px solid var(--danger-color);">
                    <strong style="color:var(--danger-color);">预测失败</strong>
                    <p style="color:var(--text-secondary);font-size:13px;
                              margin-top:6px;">
                        ${App.escapeHtml(e.message)}
                    </p>
                </div>`;
        } finally {
            if (btn) {
                btn.disabled  = false;
                btn.innerHTML = '<i class="fas fa-chart-line"></i> 开始预测';
            }
        }
    },

    // ══════════════════════════════════════════
    //  安全扫描面板
    // ══════════════════════════════════════════

    _renderSecurityPanel(sessionId) {
        return `
            <div style="max-width:900px;margin:0 auto;width:100%;">
                <div style="display:flex;align-items:center;gap:12px;
                            margin-bottom:20px;">
                    <i class="fas fa-shield-alt"
                       style="font-size:24px;color:var(--accent-color);"></i>
                    <div>
                        <h3 style="color:var(--text-bright);margin:0;">安全漏洞扫描</h3>
                        <p style="color:var(--text-secondary);font-size:12px;
                                  margin:2px 0 0;">
                            分析已安装软件包，发现已知安全风险
                        </p>
                    </div>
                </div>
                <button class="btn btn-primary"
                        id="securityBtn-${sessionId}"
                        onclick="AIAssistant.runSecurityScan('${sessionId}')">
                    <i class="fas fa-search"></i> 开始扫描
                </button>
                <div id="securityResult-${sessionId}" style="margin-top:20px;">
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:60px;background:var(--bg-secondary);
                                border-radius:12px;
                                border:1px dashed var(--border-color);">
                        <i class="fas fa-shield-alt"
                           style="font-size:40px;display:block;
                                  margin-bottom:12px;opacity:0.3;"></i>
                        点击「开始扫描」检测安全漏洞
                    </div>
                </div>
            </div>
        `;
    },

    async runSecurityScan(sessionId) {
        const btn = document.getElementById(`securityBtn-${sessionId}`);
        const div = document.getElementById(`securityResult-${sessionId}`);
        if (!div) return;
        if (btn) {
            btn.disabled  = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 扫描中...';
        }
        div.innerHTML = `<div style="text-align:center;padding:40px;
            color:var(--text-secondary);">
            <i class="fas fa-spinner fa-spin"
               style="font-size:30px;display:block;margin-bottom:12px;
                      color:var(--accent-color);"></i>
            AI 正在分析软件包安全性...
        </div>`;
        try {
            const res  = await fetch('/api/ai/security-scan', {
                method:  'POST',
                headers: App.authHeaders(),
                body:    JSON.stringify({ session_id: sessionId }),
            });
            const data = await res.json();
            if (data.status !== 'ok') throw new Error(data.message);
            const result     = data.data;
            const score      = result.security_score || 0;
            const scoreColor = score >= 80
                ? 'var(--success-color)'
                : score >= 50
                ? 'var(--warning-color)'
                : 'var(--danger-color)';
            div.innerHTML = `
                <div style="background:var(--bg-secondary);border-radius:12px;
                            padding:24px;border:1px solid var(--border-color);">
                    <div style="display:flex;align-items:center;gap:16px;
                                margin-bottom:20px;padding-bottom:16px;
                                border-bottom:1px solid var(--border-color);">
                        <div style="width:64px;height:64px;border-radius:50%;
                                    background:var(--bg-tertiary);display:flex;
                                    flex-direction:column;align-items:center;
                                    justify-content:center;
                                    border:3px solid ${scoreColor};flex-shrink:0;">
                            <span style="font-size:20px;font-weight:700;
                                         color:${scoreColor};">${score}</span>
                            <span style="font-size:10px;
                                         color:var(--text-secondary);">安全分</span>
                        </div>
                        <div>
                            <h4 style="color:var(--text-bright);margin:0 0 6px;">
                                安全评估结果
                            </h4>
                            <span style="font-size:12px;">
                                发现
                                <strong style="color:var(--danger-color);">
                                    ${result.vulnerabilities?.length || 0}
                                </strong> 个漏洞，
                                <strong style="color:var(--warning-color);">
                                    ${result.open_ports_risk?.length || 0}
                                </strong> 个端口风险
                            </span>
                        </div>
                    </div>
                    ${(result.vulnerabilities || []).map(v => {
                        const c = v.severity === 'critical'
                            ? 'var(--danger-color)'
                            : v.severity === 'high'
                            ? 'var(--warning-color)'
                            : 'var(--info-color)';
                        return `
                        <div style="padding:12px 14px;border-radius:8px;
                                    margin-bottom:8px;background:var(--bg-tertiary);
                                    border-left:4px solid ${c};">
                            <div style="display:flex;justify-content:space-between;">
                                <strong style="color:var(--text-bright);">
                                    ${App.escapeHtml(v.package)}
                                </strong>
                                <span style="font-size:11px;color:${c};">
                                    ${(v.severity || '').toUpperCase()}
                                </span>
                            </div>
                            <div style="font-size:12px;color:var(--text-secondary);
                                        margin-top:4px;">
                                ${App.escapeHtml(v.description)}
                            </div>
                            <div style="font-size:12px;color:var(--success-color);
                                        margin-top:4px;">
                                修复: ${App.escapeHtml(v.fix)}
                            </div>
                        </div>`;
                    }).join('')}
                    ${(result.recommendations || []).length ? `
                    <h4 style="color:var(--text-bright);margin:16px 0 10px;
                               font-size:14px;">
                        <i class="fas fa-shield-alt"
                           style="color:var(--success-color);"></i> 加固建议
                    </h4>
                    <ul style="padding-left:20px;font-size:13px;
                               color:var(--text-primary);">
                        ${result.recommendations.map(r =>
                            `<li style="margin-bottom:4px;">${App.escapeHtml(r)}</li>`
                        ).join('')}
                    </ul>` : ''}
                </div>`;
            App.toast(`扫描完成，发现 ${result.vulnerabilities?.length || 0} 个漏洞`, 'success');
        } catch (e) {
            div.innerHTML = `
                <div style="background:var(--alert-critical-bg);padding:20px;
                            border-radius:12px;border:1px solid var(--danger-color);">
                    <strong style="color:var(--danger-color);">扫描失败</strong>
                    <p style="color:var(--text-secondary);font-size:13px;
                              margin-top:6px;">
                        ${App.escapeHtml(e.message)}
                    </p>
                </div>`;
        } finally {
            if (btn) {
                btn.disabled  = false;
                btn.innerHTML = '<i class="fas fa-search"></i> 开始扫描';
            }
        }
    },

    // ══════════════════════════════════════════
    //  知识库面板（✅ 修复：自动加载）
    // ══════════════════════════════════════════

    _renderKnowledgePanel(sessionId) {
        return `
            <div style="max-width:900px;margin:0 auto;width:100%;">
                <div style="display:flex;align-items:center;
                            justify-content:space-between;margin-bottom:20px;
                            flex-wrap:wrap;gap:10px;">
                    <div style="display:flex;align-items:center;gap:12px;">
                        <i class="fas fa-book"
                           style="font-size:24px;color:var(--accent-color);"></i>
                        <div>
                            <h3 style="color:var(--text-bright);margin:0;">
                                运维知识库
                            </h3>
                            <p style="color:var(--text-secondary);font-size:12px;
                                      margin:2px 0 0;">
                                故障案例、操作手册、经验沉淀
                            </p>
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;">
                        <input type="text"
                               id="kbSearch-${sessionId}"
                               placeholder="搜索知识库..."
                               onkeypress="if(event.key==='Enter')
                                   AIAssistant.searchKB('${sessionId}')"
                               style="padding:7px 12px;
                                      border:1px solid var(--border-color);
                                      background:var(--bg-tertiary);
                                      color:var(--text-primary);
                                      border-radius:6px;font-size:13px;
                                      width:180px;outline:none;">
                        <button class="btn btn-sm"
                                onclick="AIAssistant.searchKB('${sessionId}')">
                            <i class="fas fa-search"></i>
                        </button>
                        <button class="btn btn-sm btn-primary"
                                onclick="AIAssistant.showAddKB('${sessionId}')">
                            <i class="fas fa-plus"></i> 新增
                        </button>
                    </div>
                </div>

                <!-- 分类筛选 -->
                <div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap;">
                    ${[
                        ['',        '全部'],
                        ['fault',   '故障案例'],
                        ['command', '命令手册'],
                        ['qa',      '问答'],
                    ].map(([cat, label]) => `
                        <button class="btn btn-sm kb-cat-btn-${sessionId}"
                                data-cat="${cat}"
                                onclick="AIAssistant._setKBCat('${sessionId}','${cat}')"
                                style="font-size:12px;">
                            ${label}
                        </button>
                    `).join('')}
                </div>

                <!-- 知识库列表 -->
                <div id="kbList-${sessionId}">
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:40px;">
                        <i class="fas fa-spinner fa-spin"></i> 加载中...
                    </div>
                </div>

                <!-- 新增弹窗 -->
                <div id="kbAddModal-${sessionId}"
                     style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;
                            z-index:2000;background:rgba(0,0,0,0.6);
                            align-items:center;justify-content:center;">
                    <div style="background:var(--bg-secondary);border-radius:12px;
                                padding:24px;width:560px;max-width:90vw;
                                max-height:80vh;overflow-y:auto;
                                border:1px solid var(--border-color);">
                        <h3 style="color:var(--text-bright);margin-bottom:16px;">
                            新增知识
                        </h3>
                        <div class="form-group">
                            <label>标题</label>
                            <input type="text" id="kbTitle-${sessionId}"
                                   placeholder="简洁的标题">
                        </div>
                        <div class="form-group">
                            <label>分类</label>
                            <select id="kbCategory-${sessionId}">
                                <option value="qa">问答</option>
                                <option value="fault">故障案例</option>
                                <option value="command">命令手册</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>内容（支持 Markdown）</label>
                            <textarea id="kbContent-${sessionId}" rows="8"
                                      style="font-family:Consolas,monospace;
                                             font-size:13px;"
                                      placeholder="内容..."></textarea>
                        </div>
                        <div class="form-group">
                            <label>标签（逗号分隔）</label>
                            <input type="text" id="kbTags-${sessionId}"
                                   placeholder="nginx, 内存, 性能">
                        </div>
                        <div style="display:flex;gap:8px;justify-content:flex-end;
                                    margin-top:8px;">
                            <button class="btn"
                                    onclick="AIAssistant.hideAddKB('${sessionId}')">
                                取消
                            </button>
                            <button class="btn btn-primary"
                                    onclick="AIAssistant.submitKB('${sessionId}')">
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    },

    _currentKBCat: {},   // 记录各 session 当前分类

    _setKBCat(sessionId, cat) {
        this._currentKBCat[sessionId] = cat;
        // 更新按钮样式
        document.querySelectorAll(`.kb-cat-btn-${sessionId}`).forEach(btn => {
            const active = btn.dataset.cat === cat;
            btn.style.background   = active ? 'var(--accent-color)' : '';
            btn.style.color        = active ? '#fff' : '';
            btn.style.borderColor  = active ? 'var(--accent-color)' : '';
        });
        this.loadKB(sessionId, cat);
    },

    async loadKB(sessionId, category = '') {
        const div = document.getElementById(`kbList-${sessionId}`);
        if (!div) return;

        // 更新当前分类记录
        if (category !== undefined) {
            this._currentKBCat[sessionId] = category;
        }

        div.innerHTML = `<div style="text-align:center;padding:20px;
            color:var(--text-secondary);">
            <i class="fas fa-spinner fa-spin"></i> 加载中...
        </div>`;

        try {
            const cat = category !== undefined
                ? category
                : (this._currentKBCat[sessionId] || '');
            const url = `/api/ai/knowledge${cat ? '?category=' + cat : ''}`;
            const res  = await fetch(url, { headers: App.authHeaders() });
            const data = await res.json();

            if (!data.data?.length) {
                div.innerHTML = `
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:40px;background:var(--bg-secondary);
                                border-radius:12px;
                                border:1px dashed var(--border-color);">
                        <i class="fas fa-book-open"
                           style="font-size:36px;display:block;
                                  margin-bottom:12px;opacity:0.3;"></i>
                        暂无知识条目，点击「新增」添加
                    </div>`;
                return;
            }

            div.innerHTML = data.data.map(entry => `
                <div style="background:var(--bg-secondary);
                            border:1px solid var(--border-color);
                            border-radius:8px;padding:14px 16px;
                            margin-bottom:8px;transition:border-color 0.2s;"
                     onmouseenter="this.style.borderColor='var(--accent-color)'"
                     onmouseleave="this.style.borderColor='var(--border-color)'">
                    <div style="display:flex;align-items:flex-start;
                                justify-content:space-between;gap:8px;">
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:14px;font-weight:600;
                                        color:var(--text-bright);margin-bottom:4px;">
                                ${App.escapeHtml(entry.title)}
                            </div>
                            <div style="font-size:12px;color:var(--text-secondary);
                                        white-space:nowrap;overflow:hidden;
                                        text-overflow:ellipsis;">
                                ${App.escapeHtml((entry.content || '').slice(0, 100))}...
                            </div>
                            <div style="margin-top:6px;display:flex;
                                        gap:4px;flex-wrap:wrap;">
                                <span style="font-size:10px;padding:1px 6px;
                                             border-radius:8px;
                                             background:var(--bg-tertiary);
                                             color:var(--text-secondary);">
                                    ${entry.category}
                                </span>
                                ${(entry.tags || []).map(t => `
                                    <span style="font-size:10px;padding:1px 6px;
                                                 border-radius:8px;
                                                 background:rgba(79,195,247,0.1);
                                                 color:var(--accent-color);">
                                        ${App.escapeHtml(t)}
                                    </span>
                                `).join('')}
                            </div>
                        </div>
                        <div style="display:flex;gap:4px;flex-shrink:0;">
                            <button class="btn btn-icon btn-sm"
                                    onclick="AIAssistant.viewKB(
                                        '${sessionId}',${JSON.stringify(entry)})"
                                    title="查看">
                                <i class="fas fa-eye" style="font-size:11px;"></i>
                            </button>
                            <button class="btn btn-icon btn-sm"
                                    onclick="AIAssistant.deleteKB(
                                        '${entry.id}','${sessionId}')"
                                    title="删除">
                                <i class="fas fa-trash"
                                   style="font-size:11px;
                                          color:var(--danger-color);"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `).join('');

        } catch (e) {
            div.innerHTML = `
                <div style="color:var(--danger-color);padding:20px;">
                    加载失败: ${App.escapeHtml(e.message)}
                </div>`;
        }
    },

    async searchKB(sessionId) {
        const q   = document.getElementById(`kbSearch-${sessionId}`)?.value?.trim();
        const div = document.getElementById(`kbList-${sessionId}`);
        if (!div) return;
        const cat = this._currentKBCat[sessionId] || '';
        const url = q
            ? `/api/ai/knowledge?q=${encodeURIComponent(q)}${cat ? '&category=' + cat : ''}`
            : `/api/ai/knowledge${cat ? '?category=' + cat : ''}`;
        const res  = await fetch(url, { headers: App.authHeaders() });
        const data = await res.json();
        if (!data.data?.length) {
            div.innerHTML = `<div style="text-align:center;
                color:var(--text-secondary);padding:40px;">未找到匹配结果</div>`;
            return;
        }
        // 复用 loadKB 的渲染
        await this.loadKB(sessionId, cat);
    },

    viewKB(sessionId, entry) {
        document.getElementById('kbViewModal')?.remove();
        const modal = document.createElement('div');
        modal.id    = 'kbViewModal';
        modal.className = 'modal visible';
        modal.innerHTML = `
            <div class="modal-overlay"
                 onclick="document.getElementById('kbViewModal').remove()">
            </div>
            <div class="modal-dialog modal-lg">
                <div class="modal-header">
                    <h3>
                        <i class="fas fa-book"
                           style="color:var(--accent-color);"></i>
                        ${App.escapeHtml(entry.title)}
                    </h3>
                    <button class="modal-close"
                            onclick="document.getElementById('kbViewModal').remove()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="modal-body"
                     style="max-height:60vh;overflow-y:auto;">
                    <div style="display:flex;gap:6px;margin-bottom:12px;">
                        <span style="font-size:11px;padding:2px 8px;
                                     border-radius:8px;
                                     background:var(--bg-tertiary);
                                     color:var(--text-secondary);">
                            ${entry.category}
                        </span>
                        ${(entry.tags || []).map(t => `
                            <span style="font-size:11px;padding:2px 8px;
                                         border-radius:8px;
                                         background:rgba(79,195,247,0.1);
                                         color:var(--accent-color);">
                                ${App.escapeHtml(t)}
                            </span>
                        `).join('')}
                    </div>
                    <div style="font-size:13px;line-height:1.8;
                                color:var(--text-primary);white-space:pre-wrap;">
                        ${App.escapeHtml(entry.content)}
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn"
                            onclick="document.getElementById('kbViewModal').remove()">
                        关闭
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    },

    showAddKB(sessionId) {
        const m = document.getElementById(`kbAddModal-${sessionId}`);
        if (m) m.style.display = 'flex';
    },

    hideAddKB(sessionId) {
        const m = document.getElementById(`kbAddModal-${sessionId}`);
        if (m) m.style.display = 'none';
    },

    async submitKB(sessionId) {
        const title    = document.getElementById(`kbTitle-${sessionId}`)?.value?.trim();
        const category = document.getElementById(`kbCategory-${sessionId}`)?.value;
        const content  = document.getElementById(`kbContent-${sessionId}`)?.value?.trim();
        const tagsRaw  = document.getElementById(`kbTags-${sessionId}`)?.value?.trim();
        const tags     = tagsRaw
            ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean)
            : [];

        if (!title || !content) {
            App.toast('标题和内容不能为空', 'warning');
            return;
        }

        try {
            const res  = await fetch('/api/ai/knowledge', {
                method:  'POST',
                headers: App.authHeaders(),
                body:    JSON.stringify({ title, content, tags, category }),
            });
            const data = await res.json();
            if (data.status === 'ok') {
                App.toast('已保存', 'success');
                this.hideAddKB(sessionId);
                // 清空表单
                ['kbTitle', 'kbContent', 'kbTags'].forEach(id => {
                    const el = document.getElementById(`${id}-${sessionId}`);
                    if (el) el.value = '';
                });
                this.loadKB(sessionId, this._currentKBCat[sessionId] || '');
            } else {
                App.toast(data.message, 'error');
            }
        } catch (e) {
            App.toast('保存失败: ' + e.message, 'error');
        }
    },

    async deleteKB(entryId, sessionId) {
        if (!confirm('确认删除此条知识？')) return;
        await fetch(`/api/ai/knowledge/${entryId}`, {
            method: 'DELETE', headers: App.authHeaders(),
        });
        App.toast('已删除', 'success');
        this.loadKB(sessionId, this._currentKBCat[sessionId] || '');
    },

    // ══════════════════════════════════════════
    //  拓扑图面板
    // ══════════════════════════════════════════

    _renderTopologyPanel(sessionId) {
        // 预加载 Mermaid 库
        if (!document.getElementById('mermaid-js')) {
            const script = document.createElement('script');
            script.id = 'mermaid-js';
            script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
            script.onload = () => { if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' }); };
            document.head.appendChild(script);
        }
        return `
            <div style="max-width:1000px;margin:0 auto;width:100%;">
                <div style="display:flex;align-items:center;gap:14px;margin-bottom:24px;
                            padding-bottom:16px;border-bottom:2px solid var(--border-color);">
                    <div style="width:42px;height:42px;border-radius:10px;
                                background:linear-gradient(135deg, #8b5cf6, #6366f1);
                                display:flex;align-items:center;justify-content:center;">
                        <i class="fas fa-project-diagram" style="font-size:18px;color:#fff;"></i>
                    </div>
                    <div>
                        <h3 style="color:var(--text-bright);margin:0;font-size:16px;">服务拓扑图</h3>
                        <p style="color:var(--text-secondary);font-size:12px;margin:3px 0 0;">
                            AI 深度分析服务器进程、端口和网络连接，生成详细的服务依赖关系图
                        </p>
                    </div>
                </div>

                <!-- 操作区 -->
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;
                            padding:16px;background:var(--bg-secondary);border-radius:10px;
                            border:1px solid var(--border-color);">
                    <button class="btn btn-primary"
                            onclick="AIAssistant.runTopology('${sessionId}')"
                            id="topoBtn-${sessionId}"
                            style="padding:10px 24px;font-size:14px;font-weight:600;
                                   display:flex;align-items:center;gap:8px;
                                   background:linear-gradient(135deg, #8b5cf6, #6366f1);
                                   border:none;border-radius:8px;color:#fff;cursor:pointer;">
                        <i class="fas fa-play"></i> 生成拓扑图
                    </button>
                    <span style="color:var(--text-secondary);font-size:12px;">
                        <i class="fas fa-info-circle" style="color:var(--accent-color);margin-right:4px;"></i>
                        请手动点击按钮，AI 将分析当前服务器并生成拓扑
                    </span>
                </div>

                <!-- 结果区 -->
                <div id="topoResult-${sessionId}">
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:60px 20px;background:var(--bg-secondary);
                                border-radius:12px;border:2px dashed var(--border-color);">
                        <i class="fas fa-project-diagram"
                           style="font-size:48px;display:block;margin-bottom:16px;opacity:0.15;"></i>
                        <p style="font-size:14px;margin:0;color:var(--text-secondary);">
                            <i class="fas fa-hand-pointer" style="margin-right:6px;"></i>
                            点击上方 <strong style="color:var(--text-bright);">「生成拓扑图」</strong> 按钮
                        </p>
                        <p style="font-size:12px;margin:8px 0 0;color:var(--text-secondary);opacity:0.7;">
                            AI 将分析进程、端口和网络连接，生成详细的服务依赖关系图
                        </p>
                    </div>
                </div>
            </div>
        `;
    },

    async runTopology(sessionId) {
        const btn = document.getElementById(`topoBtn-${sessionId}`);
        const div = document.getElementById(`topoResult-${sessionId}`);
        if (!div) return;

        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> AI 分析中...'; }
        div.innerHTML = `<div style="text-align:center;padding:50px;color:var(--text-secondary);">
            <i class="fas fa-spinner fa-spin" style="font-size:36px;display:block;margin-bottom:16px;
               color:#6366f1;"></i>
            <p style="font-size:14px;margin:0;">AI 正在分析进程、端口和网络连接...</p>
            <p style="font-size:12px;margin:6px 0 0;color:var(--text-secondary);opacity:0.6;">
                这可能需要 5-15 秒，请稍候
            </p>
        </div>`;

        try {
            const res  = await fetch('/api/ai/topology', {
                method:  'POST',
                headers: App.authHeaders(),
                body:    JSON.stringify({ session_id: sessionId }),
            });
            const data = await res.json();
            if (data.status !== 'ok') throw new Error(data.message);

            const result = data.data;
            const svcs = result.services || [];
            const deps = result.dependencies || [];
            const summary = result.summary || '拓扑分析完成';
            const mermaidCode = result.mermaid || 'graph LR\n    Server[服务器]';

            let html = '<div style="display:flex;flex-direction:column;gap:20px;">';

            // ── 1. 分析摘要 ──
            html += `<div style="background:var(--bg-secondary);border-radius:12px;
                             padding:20px 24px;border:1px solid var(--border-color);">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
                    <i class="fas fa-file-alt" style="color:#6366f1;font-size:14px;"></i>
                    <h4 style="color:var(--text-bright);margin:0;font-size:14px;">分析摘要</h4>
                </div>
                <p style="color:var(--text-primary);font-size:13px;line-height:1.8;margin:0;
                          padding:14px;background:var(--bg-tertiary);border-radius:8px;
                          border-left:3px solid #6366f1;">
                    ${App.escapeHtml(summary)}
                </p>
            </div>`;

            // ── 2. Mermaid 拓扑图（可视化渲染） ──
            html += `<div style="background:var(--bg-secondary);border-radius:12px;
                             padding:20px 24px;border:1px solid var(--border-color);">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
                    <i class="fas fa-project-diagram" style="color:#8b5cf6;font-size:14px;"></i>
                    <h4 style="color:var(--text-bright);margin:0;font-size:14px;">拓扑图</h4>
                    <span style="font-size:11px;color:var(--text-secondary);">（Mermaid 渲染）</span>
                </div>
                <div id="mermaidChart-${sessionId}" style="background:#1e1e2e;border-radius:10px;
                         padding:24px;overflow-x:auto;min-height:120px;text-align:center;">
                    <pre class="mermaid" style="display:flex;justify-content:center;">${App.escapeHtml(mermaidCode)}</pre>
                </div>
                <details style="margin-top:10px;">
                    <summary style="cursor:pointer;font-size:12px;color:var(--text-secondary);
                                    padding:6px 0;user-select:none;">
                        <i class="fas fa-code"></i> 查看 Mermaid 源码
                    </summary>
                    <pre style="font-family:Consolas,monospace;font-size:11px;color:var(--text-primary);
                                background:var(--bg-tertiary);padding:12px;border-radius:6px;
                                margin-top:6px;white-space:pre-wrap;overflow-x:auto;
                                max-height:300px;overflow-y:auto;">${App.escapeHtml(mermaidCode)}</pre>
                </details>
            </div>`;

            // ── 3. 服务清单 ──
            if (svcs.length) {
                html += `<div style="background:var(--bg-secondary);border-radius:12px;
                                 overflow:hidden;border:1px solid var(--border-color);">
                    <div style="display:flex;align-items:center;gap:8px;
                                padding:14px 18px;border-bottom:1px solid var(--border-color);">
                        <i class="fas fa-cubes" style="color:#06b6d4;font-size:13px;"></i>
                        <h4 style="color:var(--text-bright);margin:0;font-size:13px;font-weight:600;">服务清单</h4>
                        <span style="font-size:10px;padding:1px 8px;border-radius:8px;
                                     background:rgba(6,182,212,0.12);color:#06b6d4;font-weight:600;">
                            ${svcs.length}
                        </span>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:1px;padding:6px 14px 12px;
                                background:var(--bg-secondary);">
                        ${svcs.map((s, i) => {
                            const typeColors = {
                                web:     '#4fc3f7', db:      '#66bb6a', app: '#ffa726',
                                cache:   '#ef5350', proxy:   '#ab47bc', mq: '#26c6da',
                                monitor: '#7e57c2', storage: '#42a5f5',
                            };
                            const typeColor = typeColors[s.type] || '#90a4ae';
                            const statusColor = s.status === '运行中' ? '#66bb6a' : s.status === '已停止' ? '#ef5350' : '#ffa726';
                            const statusDot = s.status === '运行中' ? '●' : s.status === '已停止' ? '●' : '●';
                            return `
                            <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;
                                        background:var(--bg-tertiary);border-radius:6px;
                                        border-left:3px solid ${typeColor};transition:0.15s;"
                                 onmouseenter="this.style.background='var(--bg-hover)'"
                                 onmouseleave="this.style.background='var(--bg-tertiary)'">
                                <div style="width:30px;height:30px;border-radius:6px;
                                            background:${typeColor}18;display:flex;
                                            align-items:center;justify-content:center;flex-shrink:0;">
                                    <span style="color:${typeColor};font-weight:700;font-size:12px;">${i + 1}</span>
                                </div>
                                <div style="flex:1;min-width:0;">
                                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
                                        <strong style="color:var(--text-bright);font-size:13px;">${App.escapeHtml(s.name)}</strong>
                                        <span style="font-size:10px;padding:1px 6px;border-radius:3px;
                                                     background:${typeColor}14;color:${typeColor};font-weight:600;">
                                            ${App.escapeHtml(s.type || '?')}
                                        </span>
                                        ${s.version ? `<span style="font-size:10px;color:var(--text-secondary);">v${App.escapeHtml(s.version)}</span>` : ''}
                                    </div>
                                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                                        ${s.port ? `<span style="font-size:11px;color:var(--text-secondary);display:inline-flex;align-items:center;gap:3px;">
                                            <span style="width:4px;height:4px;border-radius:50%;background:${statusColor};"></span>:${s.port}</span>` : ''}
                                        ${s.pid ? `<span style="font-size:10px;color:var(--text-muted);">PID ${s.pid}</span>` : ''}
                                        <span style="font-size:10px;color:${statusColor};">${statusDot} ${App.escapeHtml(s.status || '?')}</span>
                                        ${s.cpu_percent != null ? `<span style="font-size:10px;color:var(--text-muted);">CPU ${s.cpu_percent}%</span>` : ''}
                                        ${s.mem_percent != null ? `<span style="font-size:10px;color:var(--text-muted);">MEM ${s.mem_percent}%</span>` : ''}
                                    </div>
                                    ${s.description ? `<div style="font-size:10px;color:var(--text-muted);
                                        line-height:1.4;opacity:0.75;margin-top:4px;">${App.escapeHtml(s.description)}</div>` : ''}
                                </div>
                            </div>`;
                        }).join('')}
                    </div>
                </div>`;
            }

            // ── 4. 调用关系 ──
            if (deps.length) {
                html += `<div style="background:var(--bg-secondary);border-radius:12px;
                                 overflow:hidden;border:1px solid var(--border-color);">
                    <div style="display:flex;align-items:center;gap:8px;
                                padding:14px 18px;border-bottom:1px solid var(--border-color);">
                        <i class="fas fa-project-diagram" style="color:#f59e0b;font-size:13px;"></i>
                        <h4 style="color:var(--text-bright);margin:0;font-size:13px;font-weight:600;">调用关系</h4>
                        <span style="font-size:10px;padding:1px 8px;border-radius:8px;
                                     background:rgba(245,158,11,0.12);color:#f59e0b;font-weight:600;">
                            ${deps.length}
                        </span>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:1px;padding:6px 14px 12px;
                                background:var(--bg-secondary);">
                        ${deps.map(d => {
                            const strengthColor = d.strength === '强依赖' ? '#ef5350' :
                                                  d.strength === '弱依赖' ? '#66bb6a' : '#ffa726';
                            const strengthLabel = d.strength || '';
                            return `
                            <div style="padding:10px 12px;background:var(--bg-tertiary);
                                        border-radius:6px;transition: background 0.15s;"
                                 onmouseenter="this.style.background='var(--bg-hover)'"
                                 onmouseleave="this.style.background='var(--bg-tertiary)'">
                                <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                                    <span style="color:#4fc3f7;font-weight:600;font-size:13px;
                                                 white-space:nowrap;flex-shrink:0;">
                                        ${App.escapeHtml(d.from)}
                                    </span>
                                    <div style="display:flex;align-items:center;gap:4px;
                                                flex:1;min-width:0;">
                                        <div style="height:1.5px;flex:1;min-width:10px;
                                                    background:linear-gradient(90deg,#4fc3f750,${strengthColor}80);
                                                    border-radius:2px;"></div>
                                        <i class="fas fa-arrow-right" style="color:${strengthColor};font-size:11px;flex-shrink:0;"></i>
                                        ${d.protocol || strengthLabel ? `
                                        <div style="display:flex;flex-direction:column;align-items:center;gap:1px;flex-shrink:0;">
                                            ${d.protocol ? `<span style="font-size:9px;padding:1px 5px;border-radius:3px;
                                                background:rgba(255,255,255,0.04);color:var(--text-muted);line-height:1.3;">
                                                ${App.escapeHtml(d.protocol)}</span>` : ''}
                                            ${strengthLabel ? `<span style="font-size:8px;color:${strengthColor};
                                                font-weight:700;line-height:1;opacity:0.9;">${App.escapeHtml(strengthLabel)}</span>` : ''}
                                        </div>` : ''}
                                        <div style="height:1.5px;flex:1;min-width:10px;
                                                    background:linear-gradient(90deg,${strengthColor}80,#66bb6a50);
                                                    border-radius:2px;"></div>
                                    </div>
                                    <span style="color:#66bb6a;font-weight:600;font-size:13px;
                                                 white-space:nowrap;flex-shrink:0;">
                                        ${App.escapeHtml(d.to)}
                                    </span>
                                </div>
                                ${d.description ? `<div style="font-size:10px;color:var(--text-muted);
                                    margin-top:6px;line-height:1.4;opacity:0.7;padding-left:2px;">
                                    ${App.escapeHtml(d.description)}</div>` : ''}
                            </div>`;
                        }).join('')}
                    </div>
                </div>`;
            }

            // ── 5. 图例 ──
            if (svcs.length || deps.length) {
                html += `<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;
                                 padding:12px 16px;background:var(--bg-secondary);border-radius:8px;
                                 border:1px solid var(--border-color);font-size:11px;color:var(--text-secondary);">
                    <span style="font-weight:600;color:var(--text-bright);">
                        <i class="fas fa-tags" style="margin-right:4px;"></i>图例：
                    </span>
                    <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;
                        background:#4fc3f7;margin-right:4px;"></span>Web</span>
                    <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;
                        background:#66bb6a;margin-right:4px;"></span>数据库</span>
                    <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;
                        background:#ffa726;margin-right:4px;"></span>应用</span>
                    <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;
                        background:#ef5350;margin-right:4px;"></span>缓存</span>
                    <span style="color:#ef5350;">● 强依赖</span>
                    <span style="color:#66bb6a;">● 弱依赖</span>
                </div>`;
            }

            html += '</div>';
            div.innerHTML = html;

            // ── 渲染 Mermaid ──
            setTimeout(async () => {
                try {
                    if (typeof mermaid !== 'undefined') {
                        const chartEl = document.getElementById(`mermaidChart-${sessionId}`);
                        if (chartEl) {
                            const preEl = chartEl.querySelector('pre.mermaid');
                            if (preEl) {
                                const tempDiv = document.createElement('div');
                                tempDiv.innerHTML = preEl.textContent || '';
                                const code = tempDiv.textContent;
                                const id = `mermaid-svg-${sessionId}-${Date.now()}`;
                                const { svg } = await mermaid.render(id, code);
                                preEl.innerHTML = svg;
                                preEl.style.display = 'block';
                            }
                        }
                    }
                } catch (e) {
                    console.warn('Mermaid 渲染失败（将保留源码）:', e);
                }
            }, 200);

            App.toast('拓扑图生成完成', 'success');

        } catch (e) {
            div.innerHTML = `<div style="background:var(--alert-critical-bg);padding:24px;
                border-radius:12px;border:1px solid var(--danger-color);text-align:center;">
                <i class="fas fa-exclamation-triangle" style="font-size:32px;color:var(--danger-color);
                   display:block;margin-bottom:12px;"></i>
                <strong style="color:var(--danger-color);font-size:14px;">拓扑生成失败</strong>
                <p style="color:var(--text-secondary);font-size:13px;margin-top:8px;">
                    ${App.escapeHtml(e.message)}
                </p>
                <button class="btn btn-sm" onclick="AIAssistant.runTopology('${sessionId}')"
                        style="margin-top:12px;border:1px solid var(--border-color);">
                    <i class="fas fa-redo"></i> 重试
                </button>
            </div>`;
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-play"></i> 生成拓扑图'; }
        }
    },
};

window.AIAssistant = AIAssistant;