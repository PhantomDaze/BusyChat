import { chmod, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import * as path from 'node:path';

/** SQLite 文件头（16 字节）。用于区分空文件/损坏文件与合法数据库。 */
export const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/** 判断文件是否以合法的 SQLite 文件头开头（空文件视为无效）。 */
export function isSqliteFile(data: Buffer): boolean {
  return data.length >= SQLITE_HEADER.length && data.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER);
}

/** 判断是否为「文件不存在」错误。 */
export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

/** 判断是否为「文件已存在」错误（open 的 wx 模式）。 */
export function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'EEXIST'
  );
}

/**
 * 尽力 fsync 目录，确保 rename/mkdir 等目录项变更本身也已落盘。
 * 部分文件系统（如某些 overlay/网络挂载）不支持目录 fsync，此时只记录警告，
 * 不把已经成功写入的数据误报为保存失败。
 */
export async function fsyncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: string }).code
        : undefined;
    // EINVAL/ENOTSUP/EISDIR/EPERM/EBADF：平台或文件系统不支持目录 fsync。
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM' && code !== 'EBADF') {
      console.warn(`[fs] failed to fsync directory ${dir}:`, error);
    }
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}

export interface AtomicWriteOptions {
  /** 目标文件权限，默认 0o600（仅属主可读写）。 */
  mode?: number;
}

/**
 * 原子且持久的文件写入：
 * 1. 以给定权限写临时文件（mode 默认 0600）；
 * 2. fsync 文件描述符，确保数据落盘；
 * 3. rename 覆盖目标文件；
 * 4. fsync 父目录，确保 rename 本身落盘。
 *
 * 崩溃只会留下临时文件，目标文件要么是旧内容、要么是新内容，绝不会被截断。
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const mode = options.mode ?? 0o600;
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const tmpPath = `${filePath}.tmp`;
  let handle;
  try {
    handle = await open(tmpPath, 'w', mode);
    // open 的 mode 会被 umask 削减；chmod 保证最终权限恰好是 0600。
    await handle.chmod(mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmpPath, filePath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }

  await fsyncDirectory(dir);
}

/**
 * 收紧现有文件/目录权限。只在权限「更宽」（含 group/other 位）时 chmod，
 * 不会因为属主位缺失（如只读文件）而意外改变语义。目标不存在时静默忽略。
 */
export async function restrictPermissions(target: string, mode: number): Promise<void> {
  try {
    const info = await stat(target);
    // mode 的 group/other 位为 0，因此只需检查这些位即可判断是否更宽。
    if ((info.mode & 0o777 & ~mode) !== 0) {
      await chmod(target, mode);
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: string }).code
          : undefined;
      // 权限收紧失败不应阻止启动，但必须让操作者看到。
      if (code !== 'EPERM' && code !== 'EACCES') {
        console.warn(`[fs] failed to restrict permissions on ${target}:`, error);
      } else {
        console.warn(`[fs] cannot restrict permissions on ${target}: ${code}`);
      }
    }
  }
}

/** 创建目录并收紧到 0700（已存在但权限更宽时同样收紧）。 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await restrictPermissions(dir, 0o700);
}

/** 保证文件存在时的权限不宽于 mode（用于启动时加固 DB/config 等文件）。 */
export async function hardenFile(filePath: string, mode = 0o600): Promise<void> {
  await restrictPermissions(filePath, mode);
}
