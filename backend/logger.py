"""
日志系统 - 修复 Windows 控制台乱码
"""
import os
import logging
import sys
from logging.handlers import RotatingFileHandler
from config import config

# 🔧 通过环境变量 LOG_LEVEL 控制日志级别，默认 DEBUG
LOG_LEVEL = os.environ.get('LOG_LEVEL', 'DEBUG').upper()
if LOG_LEVEL not in ('DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'):
    LOG_LEVEL = 'DEBUG'


class SafeStreamHandler(logging.StreamHandler):
    """Windows 控制台安全输出，自动处理编码错误"""

    def __init__(self):
        # 强制使用 utf-8 输出流（Python 3.7+）
        try:
            import io
            stream = io.TextIOWrapper(
                sys.stdout.buffer,
                encoding='utf-8',
                errors='replace',
                line_buffering=True
            )
        except AttributeError:
            # 普通 stream（非 buffer 情况）
            stream = sys.stdout
        super().__init__(stream)

    def emit(self, record):
        try:
            super().emit(record)
        except (UnicodeEncodeError, OSError):
            # 降级：把中文替换为 ascii
            record.msg = record.msg.encode('ascii', errors='replace').decode('ascii')
            try:
                super().emit(record)
            except Exception:
                pass


def setup_logger(name: str = 'WebTerminal') -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger

    logger.setLevel(getattr(logging, LOG_LEVEL, logging.DEBUG))
    fmt = logging.Formatter(
        '%(asctime)s [%(levelname)s] %(name)s: %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    # 控制台 handler（解决 Windows 乱码）
    ch = SafeStreamHandler()
    ch.setLevel(getattr(logging, LOG_LEVEL, logging.DEBUG))  # 🔧 跟随 LOG_LEVEL 环境变量
    ch.setFormatter(fmt)
    logger.addHandler(ch)

    # 文件 handler（始终 utf-8）
    try:
        fh = RotatingFileHandler(
            str(config.LOG_DIR / 'webterminal.log'),
            maxBytes=config.LOG_MAX_BYTES,
            backupCount=config.LOG_BACKUP_COUNT,
            encoding='utf-8'
        )
        fh.setLevel(getattr(logging, LOG_LEVEL, logging.DEBUG))
        fh.setFormatter(fmt)
        logger.addHandler(fh)
    except Exception as e:
        logger.warning(f'无法创建日志文件: {e}')

    return logger


def setup_audit_logger() -> logging.Logger:
    logger = logging.getLogger('WebTerminal.Audit')
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    fmt = logging.Formatter(
        '%(asctime)s AUDIT %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    try:
        fh = RotatingFileHandler(
            str(config.LOG_DIR / 'audit.log'),
            maxBytes=config.LOG_MAX_BYTES,
            backupCount=config.LOG_BACKUP_COUNT,
            encoding='utf-8'
        )
        fh.setFormatter(fmt)
        logger.addHandler(fh)
    except Exception:
        pass

    return logger


log = setup_logger()
audit_log = setup_audit_logger()