// frontend/js/alerts.js
/**
 * 告警通知系统 
 */
class AlertManager {
    constructor() {
        this.alerts      = [];
        this.unreadCount = 0;
        this._socket     = null;
    }

    /**
     * 在 App.socket 初始化完成后调用
     * App.init() 里会调用 alertManager.bindSocket(this.socket)
     */
    bindSocket(socket) {
        if (!socket) return;
        this._socket = socket;

        socket.on('alert', (data) => {
            this._addAlert(data);
            this._showNotification(data);
        });
    }

    /**
     * 从后端加载历史告警
     */
    async loadAlerts(limit = 100) {
        try {
            const res  = await fetch(`/api/alerts?limit=${limit}`, {
                headers: App.authHeaders()
            });
            const data = await res.json();
            if (data.status === 'ok') {
                this.alerts = data.data || [];
                return this.alerts;
            }
        } catch (e) {
            console.error('[AlertManager] 加载告警失败:', e);
        }
        return [];
    }

    /**
     * 清空告警（同时调用后端）
     */
    async clearAlertsRemote() {
        try {
            await fetch('/api/alerts/clear', {
                method:  'POST',
                headers: App.authHeaders()
            });
            this.clearAlerts();
            App.toast('告警已清空', 'success');
        } catch (e) {
            console.error('[AlertManager] 清空失败:', e);
            App.toast('清空失败: ' + e.message, 'error');
        }
    }

    /**
     * 确认告警
     */
    async acknowledgeAlert(alertId) {
        try {
            await fetch(`/api/alerts/${alertId}/ack`, {
                method:  'POST',
                headers: App.authHeaders()
            });
            const alert = this.alerts.find(a => a.id === alertId);
            if (alert) alert.acknowledged = true;
        } catch (e) {
            console.error('[AlertManager] 确认失败:', e);
        }
    }

    _addAlert(alert) {
        this.alerts.unshift(alert);
        this.unreadCount++;
        this._updateBadge();
    }

    _showNotification(alert) {
        // 页面内 Toast
        if (typeof App !== 'undefined') {
            App.toast(`⚠️ ${alert.host}: ${alert.message}`, 'error', 5000);
        }

        // 浏览器通知
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('WebTerminal 告警', {
                body: `${alert.host}: ${alert.message}`,
                icon: '/favicon.ico'
            });
        }

        // 在对应标签上显示小红点（防止重复添加）
        const tab = document.getElementById(`tab-${alert.node_id}`);
        if (tab && !tab.querySelector('.alert-dot')) {
            const dot       = document.createElement('span');
            dot.className   = 'alert-dot';
            dot.style.cssText = [
                'width:8px',
                'height:8px',
                'border-radius:50%',
                'background:var(--danger-color)',
                'display:inline-block',
                'margin-left:6px',
                'flex-shrink:0'
            ].join(';');
            tab.querySelector('.tab-name')?.appendChild(dot);
        }
    }

    _updateBadge() {
        document.title = this.unreadCount > 0
            ? `(${this.unreadCount}) WebTerminal`
            : 'WebTerminal';
    }

    clearAlerts() {
        this.alerts      = [];
        this.unreadCount = 0;
        this._updateBadge();
        document.querySelectorAll('.alert-dot').forEach(el => el.remove());
    }

    /**
     * 请求浏览器通知权限
     */
    requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().then(permission => {
                console.info('[AlertManager] 通知权限:', permission);
            });
        }
    }
}

// ✅ 确保全局单例
if (typeof window.alertManager === 'undefined') {
    window.alertManager = new AlertManager();
}