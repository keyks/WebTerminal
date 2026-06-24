/**
 * 快捷命令管理器 - 完整修复版
 */
const CommandManager = {
    shortcuts: [],
    _editingId: null,

    // ── 数据操作 ──

    async load() {
        try {
            const res = await fetch('/api/shortcuts', { headers: App.authHeaders() });
            const data = await res.json();
            if (data.status === 'ok') {
                this.shortcuts = data.data || [];
            }
        } catch (e) {
            console.error('加载快捷命令失败:', e);
        }
    },

    async save(name, command, description) {
        const isEdit = !!this._editingId;
        const url    = isEdit ? `/api/shortcuts/${this._editingId}` : '/api/shortcuts';
        const method = isEdit ? 'PUT' : 'POST';

        try {
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json', ...App.authHeaders() },
                body: JSON.stringify({ name, command, description })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                if (isEdit) {
                    const idx = this.shortcuts.findIndex(s => s.id === this._editingId);
                    if (idx !== -1) {
                        this.shortcuts[idx] = { ...this.shortcuts[idx], name, command, description };
                    }
                    App.toast(`快捷命令「${name}」已更新`, 'success');
                } else {
                    this.shortcuts.push(data.data);
                    App.toast(`快捷命令「${name}」已添加`, 'success');
                }
                return true;
            }
            App.toast(data.message || '操作失败', 'error');
        } catch (e) {
            App.toast('操作失败: ' + e.message, 'error');
        }
        return false;
    },

    async remove(id) {
        try {
            const res = await fetch(`/api/shortcuts/${id}`, {
                method: 'DELETE',
                headers: App.authHeaders()
            });
            const data = await res.json();
            if (data.status === 'ok') {
                this.shortcuts = this.shortcuts.filter(s => s.id !== id);
                App.toast('快捷命令已删除', 'success');
                this.renderPanel();
            }
        } catch (e) {
            App.toast('删除失败', 'error');
        }
    },

    // ── 执行命令 ──

    execute(command) {
        if (!App.activeSession) {
            App.toast('请先打开一个终端连接', 'warning');
            return;
        }
        App.socket.emit('terminal_input', {
            session_id: App.activeSession,
            data: command + '\n'
        });

        // 自动切回终端标签
        const panel = document.getElementById(`panel-${App.activeSession}`);
        if (panel) {
            const termTab = panel.querySelector('.panel-tab[data-tab="terminal"]');
            if (termTab) {
                App.switchPanelTab(App.activeSession, 'terminal', termTab);
            } else {
                // 兜底：直接显示终端包装器
                const termWrapper = panel.querySelector('.terminal-wrapper');
                if (termWrapper) termWrapper.classList.add('active');
                // 确保会话已切换
                App.switchSession(App.activeSession);
            }
        }
        App.toast('已发送命令', 'info');
    },

    // ── 弹窗控制 ──

    showAddDialog() {
        this._editingId = null;
        // 清空表单
        document.getElementById('cmdEditId').value = '';
        document.getElementById('cmdAddName').value = '';
        document.getElementById('cmdAddCommand').value = '';
        document.getElementById('cmdAddDesc').value = '';
        // 设置标题和按钮文字
        document.getElementById('cmdModalTitle').innerHTML =
            '<i class="fas fa-bolt"></i> 添加快捷命令';
        document.getElementById('cmdSaveIcon').className = 'fas fa-plus';
        document.getElementById('cmdSaveText').textContent = '添加';

        App.openModal('cmdAddModal');
        setTimeout(() => document.getElementById('cmdAddName').focus(), 120);
    },

    showEditDialog(id) {
        const s = this.shortcuts.find(x => x.id === id);
        if (!s) return;

        this._editingId = id;
        document.getElementById('cmdEditId').value = id;
        document.getElementById('cmdAddName').value = s.name;
        document.getElementById('cmdAddCommand').value = s.command;
        document.getElementById('cmdAddDesc').value = s.description || '';
        // 设置标题和按钮文字
        document.getElementById('cmdModalTitle').innerHTML =
            '<i class="fas fa-edit"></i> 编辑快捷命令';
        document.getElementById('cmdSaveIcon').className = 'fas fa-save';
        document.getElementById('cmdSaveText').textContent = '更新';

        App.openModal('cmdAddModal');
        setTimeout(() => document.getElementById('cmdAddName').focus(), 120);
    },

    async submitAdd() {
        const name    = document.getElementById('cmdAddName').value.trim();
        const command = document.getElementById('cmdAddCommand').value.trim();
        const desc    = document.getElementById('cmdAddDesc').value.trim();

        if (!name) {
            App.toast('请输入命令名称', 'warning');
            document.getElementById('cmdAddName').focus();
            return;
        }
        if (!command) {
            App.toast('请输入命令内容', 'warning');
            document.getElementById('cmdAddCommand').focus();
            return;
        }

        const ok = await this.save(name, command, desc);
        if (ok) {
            App.closeModal('cmdAddModal');
            this.renderPanel();
        }
    },

    cancelEdit() {
        this._editingId = null;
        App.closeModal('cmdAddModal');
    },

    confirmDelete(id, name) {
        App.confirm(`确定要删除快捷命令「${name}」吗？`, () => {
            this.remove(id);
        });
    },

    // ── 渲染面板 ──

    renderPanel() {
        // 渲染所有存在的 .cmd-list 容器
        document.querySelectorAll('.cmd-list').forEach(el => {
            this._renderInto(el);
        });
    },

    _renderInto(container) {
        if (!container) return;

        if (!this.shortcuts || this.shortcuts.length === 0) {
            container.innerHTML = `
                <div class="cmd-empty">
                    <i class="fas fa-terminal"></i>
                    <p>暂无快捷命令</p>
                    <p style="font-size:12px;color:var(--text-secondary);margin:4px 0 16px">
                        添加常用命令，点击即可发送到终端
                    </p>
                    <button class="btn btn-sm btn-primary" onclick="CommandManager.showAddDialog()">
                        <i class="fas fa-plus"></i> 添加命令
                    </button>
                </div>`;
            return;
        }

        container.innerHTML = this.shortcuts.map(s => {
            // 安全转义用于 onclick 的命令字符串
            const cmdJs = JSON.stringify(s.command);
            const nameJs = JSON.stringify(s.name);
            return `
                <div class="cmd-item">
                    <div class="cmd-info" onclick="CommandManager.execute(${cmdJs})"
                         title="点击发送到终端:\n${App.escapeHtml(s.command)}">
                        <div class="cmd-name">
                            <i class="fas fa-chevron-right"></i>
                            ${App.escapeHtml(s.name)}
                        </div>
                        <div class="cmd-preview">${App.escapeHtml(s.command)}</div>
                        ${s.description
                            ? `<div class="cmd-desc">${App.escapeHtml(s.description)}</div>`
                            : ''}
                    </div>
                    <div class="cmd-actions">
                        <button class="btn btn-icon btn-sm"
                                title="发送到终端"
                                onclick="CommandManager.execute(${cmdJs})">
                            <i class="fas fa-play" style="color:var(--success-color);font-size:11px"></i>
                        </button>
                        <button class="btn btn-icon btn-sm"
                                title="编辑"
                                onclick="CommandManager.showEditDialog('${s.id}')">
                            <i class="fas fa-pen" style="font-size:11px"></i>
                        </button>
                        <button class="btn btn-icon btn-sm"
                                title="删除"
                                onclick="CommandManager.confirmDelete('${s.id}', ${nameJs})">
                            <i class="fas fa-trash" style="color:var(--danger-color);font-size:11px"></i>
                        </button>
                    </div>
                </div>`;
        }).join('');
    }
};

window.CommandManager = CommandManager;