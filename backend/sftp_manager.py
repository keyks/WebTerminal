"""
SFTP 文件管理器
✅ 修复：递归删除改为迭代，防止栈溢出
✅ 修复：二进制文件检测
"""
import stat
import posixpath
from datetime import datetime
from config import config

# 常见二进制文件扩展名（禁止文本编辑）
BINARY_EXTENSIONS = {
    'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a',
    'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico',
    'mp3', 'mp4', 'avi', 'mkv', 'mov', 'wav', 'flac',
    'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'db', 'sqlite', 'sqlite3',
    'pyc', 'pyd', 'class',
}


class SFTPManager:

    @staticmethod
    def normalize(path: str) -> str:
        if not path:
            return '/'
        # 🔧 安全修复：解析路径中的 .. 和符号链接，防止路径遍历
        p = posixpath.normpath(path.replace('\\', '/'))
        if not p.startswith('/'):
            p = '/' + p
        # 二次 normpath 确保解析所有 ../
        normalized = posixpath.normpath(p)
        # 🔧 如果规范化后仍有 ..，说明尝试逃逸到根目录之上（如 /../../etc），拒绝
        if '..' in normalized.split('/'):
            raise ValueError(f'路径遍历攻击已拦截: {path}')
        if not normalized or not normalized.startswith('/'):
            return '/'
        return normalized

    @staticmethod
    def _is_path_traversal(path: str) -> bool:
        """检测路径遍历攻击"""
        normalized = posixpath.normpath(path)
        return '..' in normalized.split('/')

    @staticmethod
    def list_directory(sftp, path: str = '/') -> tuple[list, str | None, int]:
        path = SFTPManager.normalize(path)
        files = []
        try:
            for item in sftp.listdir_attr(path):
                if item.st_mode is None:
                    continue
                files.append({
                    'name':        item.filename,
                    'path':        posixpath.join(path, item.filename),
                    'size':        item.st_size or 0,
                    'is_dir':      stat.S_ISDIR(item.st_mode),
                    'is_link':     stat.S_ISLNK(item.st_mode),
                    'permissions': SFTPManager._fmt_perm(item.st_mode),
                    'perm_octal':  oct(item.st_mode & 0o777).replace('0o', ''),
                    'uid':         item.st_uid,
                    'gid':         item.st_gid,
                    'mtime':       datetime.fromtimestamp(item.st_mtime).strftime(
                        '%Y-%m-%d %H:%M:%S'
                    ) if item.st_mtime else '',
                })
            files.sort(key=lambda x: (not x['is_dir'], x['name'].lower()))
            return files, None, 200
        except PermissionError:
            return [], f'权限不足，无法访问 {path}', 403
        except FileNotFoundError:
            return [], f'目录不存在: {path}', 404
        except Exception as e:
            return [], str(e), 500

    @staticmethod
    def _fmt_perm(mode: int) -> str:
        if not mode:
            return '----------'
        p = 'd' if stat.S_ISDIR(mode) else ('l' if stat.S_ISLNK(mode) else '-')
        for who in ('USR', 'GRP', 'OTH'):
            for what, ch in (('R', 'r'), ('W', 'w'), ('X', 'x')):
                p += ch if mode & getattr(stat, f'S_I{what}{who}') else '-'
        return p

    @staticmethod
    def is_binary_file(filename: str) -> bool:
        """✅ 检测是否为二进制文件"""
        ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
        return ext in BINARY_EXTENSIONS

    @staticmethod
    def read_file(sftp, path: str) -> tuple[str | None, str | None]:
        path = SFTPManager.normalize(path)
        filename = posixpath.basename(path)
        if SFTPManager.is_binary_file(filename):
            return None, f'"{filename}" 是二进制文件，不支持文本编辑，请下载后处理'
        try:
            st = sftp.stat(path)
            file_size = st.st_size or 0          # ✅ 防御 None
            if file_size > config.MAX_EDIT_FILE_SIZE:
                size_mb = config.MAX_EDIT_FILE_SIZE // (1024 * 1024)
                return None, f'文件过大，编辑器限制 {size_mb}MB'
            with sftp.open(path, 'rb') as f:
                raw = f.read()
            if b'\x00' in raw[:8192]:
                return None, f'"{filename}" 包含二进制内容，不支持文本编辑'
            for enc in ('utf-8', 'gbk', 'latin-1'):
                try:
                    return raw.decode(enc), None
                except (UnicodeDecodeError, LookupError):
                    pass
            return raw.decode('latin-1'), None
        except PermissionError as e:
            return None, f'权限不足: {e}'
        except FileNotFoundError:               # ✅ 新增
            return None, f'文件不存在: {path}'
        except Exception as e:
            return None, str(e)

    @staticmethod
    def write_file(sftp, path: str, content: str) -> tuple[bool, str | None]:
        path = SFTPManager.normalize(path)
        try:
            with sftp.open(path, 'wb') as f:
                f.write(content.encode('utf-8'))
            return True, None
        except PermissionError as e:
            return False, f'权限不足: {e}'
        except Exception as e:
            return False, str(e)

    @staticmethod
    def create_directory(sftp, path: str) -> tuple[bool, str | None]:
        path = SFTPManager.normalize(path)
        try:
            sftp.mkdir(path)
            return True, None
        except Exception as e:
            return False, str(e)

    @staticmethod
    def delete_file(sftp, path: str) -> tuple[bool, str | None]:
        path = SFTPManager.normalize(path)
        try:
            sftp.remove(path)
            return True, None
        except Exception as e:
            return False, str(e)

    @staticmethod
    def delete_directory(sftp, path: str) -> tuple[bool, str | None]:
        path = SFTPManager.normalize(path)
        """
        ✅ 修复 BUG #5：改用迭代方式删除，避免深层嵌套导致递归栈溢出
        使用显式栈（列表）模拟深度优先遍历
        """
        try:
            # 收集所有需要删除的路径（后序遍历：先子后父）
            dirs_to_delete = []
            stack = [path]

            while stack:
                current = stack.pop()
                dirs_to_delete.append(current)
                try:
                    for item in sftp.listdir_attr(current):
                        item_path = posixpath.join(current, item.filename)
                        if stat.S_ISDIR(item.st_mode):
                            stack.append(item_path)
                        else:
                            sftp.remove(item_path)
                except Exception as e:
                    return False, f'遍历目录失败 {current}: {e}'

            # 从最深层开始删除目录
            for d in reversed(dirs_to_delete):
                try:
                    sftp.rmdir(d)
                except Exception as e:
                    return False, f'删除目录失败 {d}: {e}'

            return True, None
        except Exception as e:
            return False, str(e)

    @staticmethod
    def rename(sftp, old: str, new: str) -> tuple[bool, str | None]:
        old = SFTPManager.normalize(old)
        new = SFTPManager.normalize(new)
        try:
            sftp.rename(old, new)
            return True, None
        except Exception as e:
            return False, str(e)

    @staticmethod
    def chmod(sftp, path: str, mode: str) -> tuple[bool, str | None]:
        # 🔧 安全修复：校验 mode 为有效的八进制权限字符串
        path = SFTPManager.normalize(path)
        try:
            mode_str = str(mode).strip()
            if not mode_str or len(mode_str) > 4:
                return False, f'无效的权限模式: {mode}'
            # 验证所有字符都是八进制数字
            if not all(c in '01234567' for c in mode_str):
                return False, f'无效的权限模式（非八进制数字）: {mode}'
            sftp.chmod(path, int(mode_str, 8))
            return True, None
        except (ValueError, TypeError) as e:
            return False, f'无效的权限模式: {e}'
        except Exception as e:
            return False, str(e)