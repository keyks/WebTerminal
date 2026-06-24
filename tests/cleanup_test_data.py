"""
全面清理压测产生的所有数据，回归全新状态
用法: python tests/cleanup_test_data.py

保留:
  - 用户手动创建的连接（非 Server-* 命名）
  - admin 用户
  - 加密密钥文件

清理:
  - 数据库: 测试连接、审计日志、快捷历史、分发任务、快捷指令
  - AI 数据库: 聊天记录、知识库
  - 文件系统: recordings、logs、known_hosts
"""
import sqlite3
import shutil
from pathlib import Path

DATA_DIR = Path.home() / '.webterminal'
DB_PATH = DATA_DIR / 'webterminal.db'
AI_KB_DB = DATA_DIR / 'ai_knowledge.db'
AI_CHAT_DB = DATA_DIR / 'ai_chat_history.db'


def clean_main_db():
    if not DB_PATH.exists():
        print('[webterminal.db] 文件不存在，跳过')
        return

    conn = sqlite3.connect(str(DB_PATH))
    
    # 先统计
    stats = {}
    for table in ['connections', 'groups', 'audit_logs', 'quick_connect_history',
                   'command_shortcuts', 'distribution_tasks']:
        cnt = conn.execute(f"SELECT COUNT(*) FROM [{table}]").fetchone()[0]
        stats[table] = cnt

    # 删除测试连接（name 以 Server- 开头，IP 为 192.168.x.x 且无实际连接记录）
    del_count = conn.execute(
        "DELETE FROM connections WHERE name LIKE 'Server-%' OR name LIKE 'Server-%'"
    ).rowcount
    if del_count:
        print(f'  connections: 删除 {del_count} 条测试连接（剩余 {stats["connections"] - del_count} 条保留）')
    else:
        print(f'  connections: 无需清理（{stats["connections"]} 条均保留）')

    # 清空审计日志
    if stats['audit_logs'] > 0:
        conn.execute("DELETE FROM audit_logs")
        print(f'  audit_logs: 清空 {stats["audit_logs"]} 条')

    # 清空快捷连接历史
    if stats['quick_connect_history'] > 0:
        conn.execute("DELETE FROM quick_connect_history")
        print(f'  quick_connect_history: 清空 {stats["quick_connect_history"]} 条')

    # 清空分发任务
    if stats['distribution_tasks'] > 0:
        conn.execute("DELETE FROM distribution_tasks")
        print(f'  distribution_tasks: 清空 {stats["distribution_tasks"]} 条')

    # 清空快捷指令
    if stats['command_shortcuts'] > 0:
        conn.execute("DELETE FROM command_shortcuts")
        print(f'  command_shortcuts: 清空 {stats["command_shortcuts"]} 条')

    # 清空分组
    if stats['groups'] > 0:
        conn.execute("DELETE FROM groups")
        print(f'  groups: 清空 {stats["groups"]} 条')

    conn.commit()
    conn.close()

    # VACUUM 回收空间
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("VACUUM")
    conn.close()
    print('  [webterminal.db] VACUUM 完成')


def clean_ai_dbs():
    for db_path, name in [(AI_CHAT_DB, 'AI 聊天记录'), (AI_KB_DB, 'AI 知识库')]:
        if not db_path.exists():
            print(f'  [{db_path.name}] 文件不存在，跳过')
            continue
        conn = sqlite3.connect(str(db_path))
        tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        for t in tables:
            cnt = conn.execute(f"SELECT COUNT(*) FROM [{t[0]}]").fetchone()[0]
            if cnt > 0:
                conn.execute(f"DELETE FROM [{t[0]}]")
                print(f'  {name} [{t[0]}]: 清空 {cnt} 条')
        conn.commit()
        conn.execute("VACUUM")
        conn.close()


def clean_files():
    for subdir in ['recordings', 'logs']:
        d = DATA_DIR / subdir
        if d.exists():
            files = list(d.iterdir())
            deleted = 0
            skipped = 0
            for f in files:
                try:
                    f.unlink()
                    deleted += 1
                except PermissionError:
                    skipped += 1
            if deleted:
                print(f'  {subdir}/: 删除 {deleted} 个文件', end='')
                if skipped:
                    print(f'（{skipped} 个被占用，请先停掉 Flask 再试）')
                else:
                    print()
            elif skipped:
                print(f'  {subdir}/: {skipped} 个被占用，请先停掉 Flask 再试')

    # 清理 known_hosts
    kh = DATA_DIR / 'known_hosts'
    if kh.exists():
        size = kh.stat().st_size
        kh.unlink()
        print(f'  known_hosts: 删除 ({size} bytes)')


def show_final_state():
    print('\n  最终状态:')
    conn = sqlite3.connect(str(DB_PATH))
    for t in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
        tn = t[0]
        cnt = conn.execute(f"SELECT COUNT(*) FROM [{tn}]").fetchone()[0]
        if tn == 'users':
            if cnt == 0:
                print(f'    users: 0（admin 将在首次登录时自动创建）')
            else:
                users = conn.execute("SELECT username FROM users").fetchall()
                print(f'    users: {cnt} ({", ".join(u[0] for u in users)})')
        elif tn != 'sqlite_sequence':
            label = '保留' if cnt > 0 else '空'
            print(f'    {tn}: {cnt} ({label})')
    conn.close()


if __name__ == '__main__':
    print('═══════════════════════════════════════')
    print('  清理 WebTerminal 测试数据')
    print('═══════════════════════════════════════\n')

    print('[1/3] 主数据库 webterminal.db:')
    clean_main_db()

    print('\n[2/3] AI 数据库:')
    clean_ai_dbs()

    print('\n[3/3] 文件系统:')
    clean_files()

    show_final_state()
    print('\n清理完成！已回归全新无数据状态。')
