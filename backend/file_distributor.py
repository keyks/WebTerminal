# backend/file_distributor.py
"""
批量文件分发引擎
"""
import os
import hashlib
import threading
import uuid
from pathlib import Path
from typing import List, Dict, Optional
from dataclasses import dataclass, field
from enum import Enum

from logger import log

# ✅ 不在顶部导入 app，避免循环依赖


class ConflictStrategy(Enum):
    OVERWRITE = 'overwrite'
    SKIP      = 'skip'
    BACKUP    = 'backup'


@dataclass
class FileDistributionTask:
    task_id:         str
    source_path:     str
    target_path:     str
    target_nodes:    List[str]
    strategy:        ConflictStrategy = ConflictStrategy.OVERWRITE
    verify_md5:      bool = True
    preserve_perms:  bool = True
    is_local_source: bool = True

    results:         Dict[str, dict] = field(default_factory=dict)
    status:          str = 'pending'
    total_nodes:     int = 0
    completed_nodes: int = 0


class FileDistributor:
    _instance  = None
    _inst_lock = threading.Lock()

    def __new__(cls):
        with cls._inst_lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._active_tasks = {}
                cls._instance._task_lock    = threading.Lock()
                cls._instance._temp_dir     = Path('/tmp/wt_distribute')
                cls._instance._temp_dir.mkdir(parents=True, exist_ok=True)
        return cls._instance

    def submit_task(self, task: FileDistributionTask) -> str:
        with self._task_lock:
            task.total_nodes = len(task.target_nodes)
            task.status      = 'running'
            self._active_tasks[task.task_id] = task

        # 🔧 持久化任务到数据库
        try:
            from database import db
            db.save_distribute_task(
                task.task_id, task.source_path, task.target_path,
                task.target_nodes, task.strategy.value
            )
        except Exception as e:
            log.warning(f'[Distribute] 任务持久化失败: {e}')

        threading.Thread(
            target=self._run_task,
            args=(task,),
            daemon=True,
            name=f'Distribute-{task.task_id}'
        ).start()
        return task.task_id

    def get_task(self, task_id: str) -> Optional[FileDistributionTask]:
        with self._task_lock:
            return self._active_tasks.get(task_id)

    def _run_task(self, task: FileDistributionTask):
        # ✅ 延迟导入
        from core import db, ssh_manager

        try:
            source_md5 = None
            if task.is_local_source and os.path.isfile(task.source_path):
                source_md5 = self._calculate_md5(task.source_path)

            for node_id in task.target_nodes:
                try:
                    result = self._distribute_to_node(
                        task, node_id, source_md5, db, ssh_manager
                    )
                    task.results[node_id] = result
                    log.info(f'[Distribute {task.task_id}] 节点 {node_id}: {result}')
                except Exception as e:
                    log.error(f'[Distribute {task.task_id}] 节点 {node_id} 失败: {e}')
                    task.results[node_id] = {'success': False, 'error': str(e)}
                finally:
                    task.completed_nodes += 1
                    # 🔧 实时持久化进度
                    try:
                        db.update_distribute_task(
                            task.task_id,
                            completed_nodes=task.completed_nodes,
                            results=task.results
                        )
                    except Exception:
                        pass

            task.status = 'done'
            # 🔧 持久化最终状态
            try:
                db.update_distribute_task(
                    task.task_id, status='done',
                    completed_nodes=task.completed_nodes,
                    results=task.results
                )
            except Exception:
                pass
        except Exception as e:
            log.error(f'[Distribute {task.task_id}] 任务异常: {e}')
            task.status = 'failed'
            try:
                db.update_distribute_task(
                    task.task_id, status='failed',
                    results=task.results
                )
            except Exception:
                pass

    def _distribute_to_node(self, task, node_id, source_md5, db, ssh_manager):
        conn_info = db.get_connection(node_id)
        if not conn_info:
            return {'success': False, 'error': '连接配置不存在'}

        session_id = f"dist_{uuid.uuid4().hex[:8]}"
        success, msg = ssh_manager.create_session(
            session_id, conn_info, f"dist-{conn_info.get('host')}"
        )
        if not success:
            return {'success': False, 'error': msg}

        session = ssh_manager.get_session(session_id)
        sftp    = session.get_sftp()
        if not sftp:
            ssh_manager.remove_session(session_id)
            return {'success': False, 'error': 'SFTP连接失败'}

        try:
            target_exists = self._path_exists(sftp, task.target_path)

            if target_exists:
                if task.strategy == ConflictStrategy.SKIP:
                    return {'success': True, 'message': '跳过 (已存在)', 'skipped': True}
                elif task.strategy == ConflictStrategy.BACKUP:
                    self._backup_file(sftp, task.target_path)

            if not task.is_local_source:
                return {'success': False, 'error': '远端到远端分发暂未实现'}

            if not os.path.isfile(task.source_path):
                return {'success': False, 'error': f'源文件不存在: {task.source_path}'}

            sftp.put(task.source_path, task.target_path)

            target_md5 = None
            if task.verify_md5 and source_md5:
                target_md5 = self._remote_md5(session, task.target_path)
                if target_md5 != source_md5:
                    return {
                        'success': False,
                        'error':   f'MD5校验失败: 期望 {source_md5}, 实际 {target_md5}'
                    }

            if task.preserve_perms:
                mode = os.stat(task.source_path).st_mode
                sftp.chmod(task.target_path, mode & 0o777)

            return {'success': True, 'message': '分发成功', 'md5': target_md5}

        finally:
            ssh_manager.remove_session(session_id)

    def _path_exists(self, sftp, path: str) -> bool:
        try:
            sftp.stat(path)
            return True
        except Exception:
            return False

    def _backup_file(self, sftp, path: str):
        from datetime import datetime
        backup = f"{path}.bak_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        try:
            sftp.rename(path, backup)
        except Exception as e:
            log.warning(f'[Distribute] 备份失败: {e}')

    def _calculate_md5(self, file_path: str, chunk_size: int = 8192) -> str:
        md5 = hashlib.md5()
        with open(file_path, 'rb') as f:
            while chunk := f.read(chunk_size):
                md5.update(chunk)
        return md5.hexdigest()

    def _remote_md5(self, session, remote_path: str) -> str:
        # 🔧 使用统一安全命令构建工具，防止命令注入
        from ssh_manager import safe_command
        cmd = safe_command("md5sum {path} 2>/dev/null || md5 -q {path} 2>/dev/null", path=remote_path)
        stdout, _ = session.execute_command(cmd, timeout=30)
        parts  = stdout.strip().split()
        return parts[0] if parts else ''