// frontend/js/cluster.js
/**
 * 集群批量运维控制台
 */
class ClusterConsole {
    constructor() {
        this.selectedNodes = new Set();
        this.nodes = [];
        this.activeTask = null;
        this.results = {};
        this.isBatchMode = false;
    }

    /**
     * 渲染节点选择器
     */
    renderNodeSelector(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        // 加载节点列表
        this._loadNodes().then(() => {
            container.innerHTML = `
                <div class="cluster-selector">
                    <div class="selector-header">
                        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                            <span style="font-weight:600;font-size:14px;color:var(--text-bright)">
                                <i class="fas fa-server"></i> 集群节点
                            </span>
                            <div class="selector-actions">
                                <button class="btn btn-sm" onclick="clusterConsole.selectAll()">
                                    <i class="fas fa-check-double"></i> 全选
                                </button>
                                <button class="btn btn-sm" onclick="clusterConsole.deselectAll()">
                                    <i class="fas fa-times"></i> 取消
                                </button>
                                <button class="btn btn-sm" onclick="clusterConsole.filterByGroup()">
                                    <i class="fas fa-filter"></i> 按分组
                                </button>
                            </div>
                            <span class="node-count" style="font-size:12px;color:var(--text-secondary)">
                                已选: <span id="selectedCount">0</span> / ${this.nodes.length}
                            </span>
                        </div>
                        <div class="batch-toggle">
                            <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
                                <input type="checkbox" id="syncInputMode" 
                                       onchange="clusterConsole.toggleSyncMode(this.checked)">
                                <i class="fas fa-bullhorn"></i> 同步输入模式
                            </label>
                        </div>
                    </div>
                    <div class="selector-body" style="max-height:300px;overflow-y:auto;margin-top:12px">
                        ${this._renderNodeList()}
                    </div>
                </div>
            `;
            this._updateCounter();
            // 🔧 恢复同步输入模式状态
            this._restoreSyncMode();
        });
    }

    async _loadNodes() {
        try {
            const res = await fetch('/api/cluster/nodes', {
                headers: App.authHeaders()
            });
            const data = await res.json();
            if (data.status === 'ok') {
                this.nodes = data.data || [];
                // 按分组排序
                this.nodes.sort((a, b) => (a.group_id || '').localeCompare(b.group_id || ''));
            }
        } catch (e) {
            console.error('加载节点失败:', e);
        }
    }

    _renderNodeList() {
        const groups = {};
        for (const node of this.nodes) {
            const gid = node.group_id || '__default__';
            if (!groups[gid]) groups[gid] = [];
            groups[gid].push(node);
        }

        let html = '';
        for (const [gid, nodes] of Object.entries(groups)) {
            const groupName = gid === '__default__' ? '默认分组' : 
                (App.groups.find(g => g.id === gid)?.name || gid);
            html += `
                <div class="node-group">
                    <div class="node-group-header" style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--bg-tertiary);border-radius:4px;margin-top:4px;font-size:12px;color:var(--text-secondary);font-weight:600">
                        <i class="fas fa-folder"></i> ${groupName}
                        <span style="font-weight:400">(${nodes.length})</span>
                    </div>
                    ${nodes.map(n => `
                        <div class="node-item" style="display:flex;align-items:center;gap:10px;padding:6px 12px;border-radius:4px;cursor:pointer;transition:background 0.2s"
                             onclick="clusterConsole.toggleNode('${n.node_id}')"
                             onmouseenter="this.style.background='var(--bg-hover)'"
                             onmouseleave="this.style.background='${this.selectedNodes.has(n.node_id) ? 'var(--bg-active)' : 'transparent'}'"
                             style="background:${this.selectedNodes.has(n.node_id) ? 'var(--bg-active)' : 'transparent'}">
                            <input type="checkbox" ${this.selectedNodes.has(n.node_id) ? 'checked' : ''}
                                   onclick="event.stopPropagation();clusterConsole.toggleNode('${n.node_id}')">
                            <div style="flex:1;min-width:0">
                                <div style="font-size:13px;font-weight:500;color:var(--text-bright)">
                                    ${App.escapeHtml(n.name || n.host)}
                                </div>
                                <div style="font-size:11px;color:var(--text-secondary)">
                                    ${n.username}@${n.host}:${n.port}
                                </div>
                            </div>
                            <span style="font-size:11px;color:var(--text-secondary)">${n.status || 'active'}</span>
                        </div>
                    `).join('')}
                </div>
            `;
        }
        return html;
    }

    toggleNode(nodeId) {
        if (this.selectedNodes.has(nodeId)) {
            this.selectedNodes.delete(nodeId);
        } else {
            this.selectedNodes.add(nodeId);
        }
        this._updateUI();
    }

    selectAll() {
        this.nodes.forEach(n => this.selectedNodes.add(n.node_id));
        this._updateUI();
    }

    deselectAll() {
        this.selectedNodes.clear();
        this._updateUI();
    }

    toggleSyncMode(enabled) {
        this.isBatchMode = enabled;
        // 🔧 持久化同步模式状态到 sessionStorage
        try { sessionStorage.setItem('cluster_sync_mode', enabled ? '1' : '0'); } catch (_) {}
        if (enabled) {
            App.toast('已开启同步输入模式，输入将广播到所有选中节点', 'info');
        }
    }

    /**
     * 🔧 恢复同步输入模式状态（在渲染 UI 后调用）
     */
    _restoreSyncMode() {
        try {
            const saved = sessionStorage.getItem('cluster_sync_mode');
            if (saved === '1') {
                this.isBatchMode = true;
                const checkbox = document.getElementById('syncInputMode');
                if (checkbox) checkbox.checked = true;
            }
        } catch (_) {}
    }

    _updateUI() {
        // 更新复选框状态
        document.querySelectorAll('.node-item input[type="checkbox"]').forEach(cb => {
            const nodeId = cb.closest('.node-item')?.getAttribute('data-node-id') ||
                          cb.closest('.node-item')?.querySelector('[data-node-id]')?.dataset?.nodeId;
            if (nodeId) {
                cb.checked = this.selectedNodes.has(nodeId);
                cb.closest('.node-item').style.background = this.selectedNodes.has(nodeId) ? 'var(--bg-active)' : 'transparent';
            }
        });
        this._updateCounter();
    }

    _updateCounter() {
        const el = document.getElementById('selectedCount');
        if (el) el.textContent = this.selectedNodes.size;
    }

    /**
     * 批量执行命令
     */
    async executeBatchCommand(command) {
        if (this.selectedNodes.size === 0) {
            App.toast('请先选择至少一个节点', 'warning');
            return;
        }

        const nodeIds = Array.from(this.selectedNodes);
        const taskId = `batch_${Date.now()}`;
        
        // 显示进度
        this._showProgressModal(taskId, nodeIds.length);

        try {
            const res = await fetch('/api/cluster/batch-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...App.authHeaders() },
                body: JSON.stringify({
                    node_ids: nodeIds,
                    command: command,
                    config: {
                        batch_size: 5,
                        batch_interval: 1,
                        max_concurrent: 10,
                        timeout: 300,
                        retry_count: 2,
                        stop_on_error: false
                    }
                })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                this.activeTask = data.task_id;
                App.toast(`任务已提交: ${data.task_id}`, 'success');
                // 开始轮询状态
                this._pollTaskStatus(data.task_id);
            } else {
                App.toast(data.message || '提交失败', 'error');
            }
        } catch (e) {
            App.toast('提交失败: ' + e.message, 'error');
        }
    }

    _showProgressModal(taskId, total) {
        const modal = document.createElement('div');
        modal.className = 'modal visible';
        modal.id = 'batchProgressModal';
        modal.innerHTML = `
            <div class="modal-overlay"></div>
            <div class="modal-dialog modal-lg">
                <div class="modal-header">
                    <h3><i class="fas fa-tasks"></i> 批量任务执行中</h3>
                    <button class="modal-close" onclick="clusterConsole.cancelTask()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="modal-body">
                    <div class="task-progress">
                        <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                            <span>任务ID: <code>${taskId}</code></span>
                            <span id="progressText">0 / ${total}</span>
                        </div>
                        <div class="progress-bar-wrap" style="width:100%;height:8px;background:var(--bg-tertiary);border-radius:4px;overflow:hidden">
                            <div id="progressBar" style="height:100%;width:0%;background:var(--progress-bar-color);transition:width 0.3s"></div>
                        </div>
                    </div>
                    <div class="task-results" style="margin-top:16px;max-height:400px;overflow-y:auto" id="taskResults">
                        <div style="text-align:center;color:var(--text-secondary);padding:20px">
                            <i class="fas fa-spinner fa-spin"></i> 等待执行...
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-danger" onclick="clusterConsole.cancelTask()">
                        <i class="fas fa-stop"></i> 取消任务
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    _pollTaskStatus(taskId) {
        const poll = async () => {
            try {
                const res = await fetch(`/api/cluster/task/${taskId}/status`, {
                    headers: App.authHeaders()
                });
                const data = await res.json();
                if (data.status === 'ok') {
                    this._updateProgress(data.data);
                    if (data.data.status !== 'done') {
                        setTimeout(poll, 1000);
                    } else {
                        App.toast('批量任务已完成', 'success');
                    }
                }
            } catch (e) {
                console.error('轮询状态失败:', e);
            }
        };
        poll();
    }

    _updateProgress(status) {
        const total = status.total || 1;
        const done = status.done || 0;
        const pct = Math.round((done / total) * 100);
        
        document.getElementById('progressBar').style.width = pct + '%';
        document.getElementById('progressText').textContent = `${done} / ${total}`;

        // 渲染结果
        const resultsContainer = document.getElementById('taskResults');
        if (resultsContainer) {
            const results = status.results || {};
            let html = '';
            for (const [nodeId, result] of Object.entries(results)) {
                const isSuccess = result.success !== false;
                html += `
                    <div class="result-item" style="padding:8px 12px;margin-bottom:4px;border-radius:4px;background:${isSuccess ? 'rgba(102,187,106,0.1)' : 'rgba(239,83,80,0.1)'};border-left:3px solid ${isSuccess ? 'var(--success-color)' : 'var(--danger-color)'}">
                        <div style="display:flex;justify-content:space-between;align-items:center">
                            <span style="font-weight:500;color:var(--text-bright)">
                                ${result.host || nodeId}
                            </span>
                            <span style="font-size:12px;color:${isSuccess ? 'var(--success-color)' : 'var(--danger-color)'}">
                                ${isSuccess ? '✓ 成功' : '✗ 失败'}
                            </span>
                        </div>
                        ${isSuccess ? `
                            <div style="font-size:12px;font-family:monospace;color:var(--text-secondary);max-height:80px;overflow-y:auto;white-space:pre-wrap;margin-top:4px;padding:4px 8px;background:var(--bg-tertiary);border-radius:4px">
                                ${App.escapeHtml(result.stdout || result.stderr || '')}
                            </div>
                        ` : `
                            <div style="font-size:12px;color:var(--danger-color);margin-top:4px">
                                ${App.escapeHtml(result.error || '未知错误')}
                            </div>
                        `}
                    </div>
                `;
            }
            resultsContainer.innerHTML = html || '<div style="text-align:center;color:var(--text-secondary);padding:20px">暂无结果</div>';
        }
    }

    async cancelTask() {
        if (!this.activeTask) return;
        try {
            await fetch(`/api/cluster/task/${this.activeTask}/cancel`, {
                method: 'POST',
                headers: App.authHeaders()
            });
            App.toast('任务已取消', 'warning');
            document.getElementById('batchProgressModal')?.classList.remove('visible');
        } catch (e) {
            App.toast('取消失败: ' + e.message, 'error');
        }
    }
}

window.clusterConsole = new ClusterConsole();