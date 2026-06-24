# backend/cluster_scheduler.py
"""
集群批量任务调度引擎
支持：同步执行、分批执行、延时执行、并发控制
"""

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Semaphore
from typing import List, Dict, Any, Callable, Optional
from dataclasses import dataclass
from datetime import datetime
import threading

from logger import log


@dataclass
class BatchExecutionConfig:
    """批量执行配置"""
    batch_size: int = 5              # 每批执行数量
    batch_interval: float = 1.0      # 批次间隔(秒)
    max_concurrent: int = 10         # 最大并发数
    timeout: int = 300               # 单节点超时(秒)
    retry_count: int = 2             # 失败重试次数
    retry_interval: int = 5          # 重试间隔(秒)
    stop_on_error: bool = False      # 遇错停止
    delay: float = 0                 # 全局延迟(秒)


class ClusterScheduler:
    """集群任务调度器"""
    
    _instance = None
    _executor = ThreadPoolExecutor(max_workers=50)
    _running_tasks: Dict[str, Any] = {}
    _task_lock = threading.Lock()
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def submit_task(self, task_id: str, nodes: List[Dict], 
                   executor: Callable, config: BatchExecutionConfig,
                   on_progress: Optional[Callable] = None,
                   on_complete: Optional[Callable] = None):
        """
        提交批量任务
        
        Args:
            task_id: 任务ID
            nodes: 节点列表 [{node_id, conn_id, host, ...}]
            executor: 执行函数 async def(node) -> result
            config: 执行配置
            on_progress: 进度回调
            on_complete: 完成回调
        """
        with self._task_lock:
            if task_id in self._running_tasks:
                raise ValueError(f"任务 {task_id} 已在运行")
            
            task = {
                'nodes': nodes,
                'executor': executor,
                'config': config,
                'on_progress': on_progress,
                'on_complete': on_complete,
                'results': {},
                'status': 'running',
                'start_time': time.time(),
                'cancelled': False
            }
            self._running_tasks[task_id] = task
        
        # 异步执行
        future = self._executor.submit(
            self._run_task, task_id, task
        )
        future.add_done_callback(lambda _: self._cleanup_task(task_id))
        return future
    
    def _run_task(self, task_id: str, task: Dict):
        from core import db, ssh_manager
        """执行任务"""
        nodes = task['nodes']
        config = task['config']
        executor = task['executor']
        results = {}
        total = len(nodes)
        
        # 应用全局延迟
        if config.delay > 0:
            time.sleep(config.delay)
        
        # 分批执行
        for batch_idx in range(0, total, config.batch_size):
            if task['cancelled']:
                break
            
            batch = nodes[batch_idx:batch_idx + config.batch_size]
            log.info(f"[BatchTask {task_id}] 执行批次 {batch_idx // config.batch_size + 1}, 节点数: {len(batch)}")
            
            # 并发执行当前批次
            semaphore = Semaphore(config.max_concurrent)
            
            def execute_node(node):
                with semaphore:
                    if task['cancelled']:
                        return None
                    return self._execute_node_with_retry(
                        node, executor, config
                    )
            
            # 使用线程池执行批次
            batch_futures = [
                self._executor.submit(execute_node, node)
                for node in batch
            ]
            
            # 收集结果
            for future, node in zip(batch_futures, batch):
                try:
                    result = future.result(timeout=config.timeout + 30)
                    if result:
                        results[node['node_id']] = result
                except Exception as e:
                    log.error(f"[BatchTask {task_id}] 节点 {node.get('host')} 执行失败: {e}")
                    results[node['node_id']] = {'error': str(e), 'success': False}
                    if config.stop_on_error:
                        task['cancelled'] = True
                        break
                
                # 更新进度
                if task['on_progress']:
                    try:
                        task['on_progress'](len(results), total, results)
                    except Exception:
                        pass
            
            # 批次间隔
            if batch_idx + config.batch_size < total:
                time.sleep(config.batch_interval)
        
        # 任务完成
        task['status'] = 'done'
        if task['on_complete']:
            try:
                task['on_complete'](results)
            except Exception:
                pass
        
        return results
    
    def _execute_node_with_retry(self, node: Dict, executor: Callable, 
                                  config: BatchExecutionConfig):
        """带重试的节点执行"""
        last_error = None
        for attempt in range(config.retry_count + 1):
            if attempt > 0:
                time.sleep(config.retry_interval)
            
            try:
                result = executor(node)
                if isinstance(result, dict) and result.get('success') is False:
                    last_error = result.get('error', '执行失败')
                    continue
                return result
            except Exception as e:
                last_error = str(e)
                continue
        
        return {'success': False, 'error': last_error}
    
    def cancel_task(self, task_id: str):
        """取消任务"""
        with self._task_lock:
            if task_id in self._running_tasks:
                self._running_tasks[task_id]['cancelled'] = True
                return True
        return False
    
    def get_task_status(self, task_id: str) -> Optional[Dict]:
        """获取任务状态"""
        with self._task_lock:
            if task_id in self._running_tasks:
                task = self._running_tasks[task_id]
                return {
                    'status': task['status'],
                    'total': len(task['nodes']),
                    'done': len(task['results']),
                    'results': task['results']
                }
        return None
    
    def _cleanup_task(self, task_id: str):
        with self._task_lock:
            self._running_tasks.pop(task_id, None)