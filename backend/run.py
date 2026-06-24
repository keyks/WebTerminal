"""
WebTerminal 备选启动脚本
在导入 backend 模块之前设置环境变量，确保 config.py 能正确读取。
如果 .env 文件已正确配置，直接运行 backend/app.py 即可。
"""
import os

# ══════════════════════════════════════════
# 在导入任何 backend 模块之前设置环境变量
# 替换为你的真实 Key（或直接在 .env 中配置，推荐方式）
# ══════════════════════════════════════════
# os.environ['GROQ_API_KEY'] = 'gsk_...您的真实Key...'

from backend.app import app, socketio

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=False)
