import { MindError } from '../model.ts';
import { ZodError } from 'zod';
export const READ_ONLY = '当前会话是只读模式，请在输入框下方把权限切换为“工作区内修改”后重试';
export function readableError(error: unknown): { code: string; message: string; details: object } {
  if (error instanceof MindError) return { code: error.code, message: error.message, details: {} };
  if (error instanceof ZodError) {
    const fields = error.issues.map((issue) => {
      const field = issue.path.includes('title')
        ? '标题'
        : issue.path.includes('body')
          ? '正文'
          : issue.path.includes('note')
            ? '写作说明'
            : '输入内容';
      return issue.code === 'too_big'
        ? `${field}最多 ${issue.maximum} 个字符或项目`
        : issue.code === 'too_small'
          ? `${field}不能为空或少于规定数量`
          : `${field}的格式不符合要求`;
    });
    return {
      code: 'VALIDATION',
      message: [...new Set(fields)].join('；'),
      details: { fields: error.issues.map((issue) => issue.path.join('.')) },
    };
  }
  const value = error as { code?: string; message?: string } | null;
  const code = value?.code ?? 'MINDWRITE_ERROR';
  let message = '操作未完成，请检查文件是否可用，并刷新导图后重试';
  if (code === 'FS_SANDBOX_DENIED')
    message = /read-only/.test(value?.message ?? '')
      ? READ_ONLY
      : '当前会话没有此文件的写入权限，请检查工作区和输入框下方的权限设置';
  else if (['EACCES', 'EPERM', 'FS_PERMISSION_DENIED'].includes(code))
    message = '无法写入文件，请检查目录权限，并关闭可能占用文件的程序';
  else if (['FS_STALE_VERSION', 'FS_ALREADY_EXISTS', 'FS_NOT_OBSERVED', 'EEXIST'].includes(code))
    message = '文件已存在或已被其他程序修改，请刷新后重试';
  else if (code === 'ENAMETOOLONG' || /\bENAMETOOLONG\b/.test(value?.message ?? ''))
    message = '文件名或所在目录路径过长，请缩短导出文件名或选择较短的工作区路径';
  else if (code === 'ENOSPC' || /\bENOSPC\b/.test(value?.message ?? ''))
    message = '磁盘空间不足，请释放空间后重试';
  else if (error instanceof SyntaxError) message = '文稿格式无法读取，请恢复有效备份或重新导入原稿';
  return { code, message, details: { code, message: value?.message ?? String(error) } };
}
