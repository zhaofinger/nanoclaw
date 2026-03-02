/**
 * API Error detection and notification utilities
 */

/** Patterns that indicate API-related errors (quota, rate limit, auth) */
const API_ERROR_PATTERNS = [
  /usage limit.*billing cycle/i,
  /quota.*refreshed/i,
  /permission_error/i,
  /rate.?limit/i,
  /authentication.*failed/i,
  /API Error: 403/i,
  /API Error: 429/i,
  /insufficient.*quota/i,
  /Claude Code process exited with code 1/i,
];

export interface ApiErrorResult {
  isApiError: boolean;
  errorType: 'quota' | 'rate_limit' | 'auth' | 'unknown';
  userMessage: string;
}

/**
 * Check if an error message indicates an API problem.
 */
export function detectApiError(
  error: string | null | undefined,
): ApiErrorResult {
  if (!error) {
    return { isApiError: false, errorType: 'unknown', userMessage: '' };
  }

  const isApiError = API_ERROR_PATTERNS.some((pattern) => pattern.test(error));

  if (!isApiError) {
    return { isApiError: false, errorType: 'unknown', userMessage: '' };
  }

  // Determine error type for better messaging
  let errorType: ApiErrorResult['errorType'] = 'unknown';
  if (/quota|usage limit|billing cycle/i.test(error)) {
    errorType = 'quota';
  } else if (/rate.?limit|429/i.test(error)) {
    errorType = 'rate_limit';
  } else if (/auth|403|permission/i.test(error)) {
    errorType = 'auth';
  }

  const userMessage = formatUserMessage(error, errorType);

  return { isApiError: true, errorType, userMessage };
}

/**
 * Format a user-friendly error message.
 */
function formatUserMessage(
  error: string,
  errorType: ApiErrorResult['errorType'],
): string {
  const errorBrief = error.slice(0, 300);

  switch (errorType) {
    case 'quota':
      return (
        `⚠️ **API 配额已用尽**\n\n` +
        `当前计费周期的 API 配额已用完，请等待配额重置或升级套餐。\n\n` +
        `\`${errorBrief}\``
      );
    case 'rate_limit':
      return (
        `⚠️ **API 请求频率超限**\n\n` +
        `请求过于频繁，请稍后再试。\n\n` +
        `\`${errorBrief}\``
      );
    case 'auth':
      return (
        `⚠️ **API 认证失败**\n\n` +
        `请检查 API 密钥是否有效。\n\n` +
        `\`${errorBrief}\``
      );
    default:
      return (
        `⚠️ **API 错误**\n\n` +
        `处理请求时遇到 API 问题：\n\n` +
        `\`${errorBrief}\``
      );
  }
}

/**
 * Format a message for scheduled task API error notification.
 */
export function formatTaskApiErrorMessage(
  taskPrompt: string,
  error: string,
): string {
  const { userMessage } = detectApiError(error);
  const taskBrief = taskPrompt.slice(0, 100);

  return (
    `${userMessage}\n\n` +
    `---\n\n` +
    `📋 **已暂停的定时任务**：\n${taskBrief}...\n\n` +
    `任务已自动暂停，请在解决问题后手动恢复。`
  );
}
