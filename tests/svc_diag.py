"""诊断 Windows 服务环境下的 AI 配置"""
import sys, os, json

print("=== 进程环境 ===")
print(f"  Python:    {sys.executable}")
print(f"  CWD:       {os.getcwd()}")
print(f"  User:      {os.environ.get('USERNAME', 'N/A')}")
print(f"  COMPUTERNAME: {os.environ.get('COMPUTERNAME', 'N/A')}")

print("\n=== 环境变量 ===")
for k in ['DATA_DIR', 'GROQ_API_KEY', 'GROQ_MODEL', 'AI_ENABLED', 'ENCRYPTION_KEY']:
    val = os.environ.get(k, '')
    if 'KEY' in k and val:
        val = val[:20] + '...' + val[-6:]
    print(f"  {k} = {val}")

# 检查 .env 加载
from pathlib import Path
env_paths = [
    Path('d:/WebShell/backend/.env'),
    Path('backend/.env'),
    Path('.env'),
]
print("\n=== .env 文件 ===")
for p in env_paths:
    exists = p.exists()
    print(f"  {p} -> {'EXISTS' if exists else 'NOT FOUND'}")

# 尝试加载 backend 模块
print("\n=== 配置模块 ===")
try:
    sys.path.insert(0, 'd:\\WebShell\\backend')
    from config import config
    print(f"  DATA_DIR:       {config.DATA_DIR}")
    print(f"  GROQ_API_KEY:   {config.GROQ_API_KEY[:20]}...")
    print(f"  GROQ_MODEL:     {config.GROQ_MODEL}")
    print(f"  AI_ENABLED:     {config.AI_ENABLED}")
    print(f"  ENCRYPTION_KEY: {config.ENCRYPTION_KEY[:20].decode() if isinstance(config.ENCRYPTION_KEY, bytes) else str(config.ENCRYPTION_KEY)[:20]}...")
    
    # 检查 DATA_DIR 下的文件
    dd = config.DATA_DIR
    print(f"\n=== DATA_DIR 内容 ({dd}) ===")
    if dd.exists():
        for f in sorted(dd.iterdir()):
            print(f"  {f.name}  ({f.stat().st_size} bytes)")
    else:
        print("  DATA_DIR does not exist!")
        
    # 检查 ai_config.json
    ai_cfg = dd / 'ai_config.json'
    print(f"\n=== ai_config.json ===")
    if ai_cfg.exists():
        raw = json.loads(ai_cfg.read_text('utf-8'))
        print(f"  has api_key_enc: {bool(raw.get('api_key_enc'))}")
        if raw.get('api_key_enc'):
            enc = raw['api_key_enc']
            print(f"  enc len: {len(enc)}, starts: {enc[:40]}...")
            # 尝试解密
            try:
                from cryptography.fernet import Fernet
                dec = Fernet(config.ENCRYPTION_KEY).decrypt(enc.encode('ascii')).decode('utf-8')
                print(f"  decrypted: {dec[:20]}...{dec[-6:]}")
            except Exception as e:
                print(f"  DECRYPT FAILED: {e}")
        print(f"  has api_key:    {bool(raw.get('api_key'))}")
    else:
        print("  ai_config.json NOT FOUND")
        
except Exception as e:
    print(f"  ERROR loading config: {e}")
    import traceback
    traceback.print_exc()
