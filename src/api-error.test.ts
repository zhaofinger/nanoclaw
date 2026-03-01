import { describe, it, expect } from 'vitest';
import { detectApiError, formatTaskApiErrorMessage } from './api-error.js';

describe('api-error', () => {
  describe('detectApiError', () => {
    it('detects quota exceeded errors', () => {
      const result = detectApiError('usage limit exceeded for this billing cycle');
      expect(result.isApiError).toBe(true);
      expect(result.errorType).toBe('quota');
      expect(result.userMessage).toContain('配额已用尽');
    });

    it('detects quota refreshed errors', () => {
      const result = detectApiError('Your quota will be refreshed soon');
      expect(result.isApiError).toBe(true);
      expect(result.errorType).toBe('quota');
    });

    it('detects rate limit errors', () => {
      const result = detectApiError('rate limit exceeded, please retry after 60s');
      expect(result.isApiError).toBe(true);
      expect(result.errorType).toBe('rate_limit');
      expect(result.userMessage).toContain('请求频率超限');
    });

    it('detects 429 errors', () => {
      const result = detectApiError('API Error: 429 Too Many Requests');
      expect(result.isApiError).toBe(true);
      expect(result.errorType).toBe('rate_limit');
    });

    it('detects authentication errors', () => {
      const result = detectApiError('authentication failed: invalid API key');
      expect(result.isApiError).toBe(true);
      expect(result.errorType).toBe('auth');
      expect(result.userMessage).toContain('认证失败');
    });

    it('detects 403 permission errors', () => {
      const result = detectApiError('API Error: 403 Forbidden');
      expect(result.isApiError).toBe(true);
      expect(result.errorType).toBe('auth');
    });

    it('detects permission_error', () => {
      const result = detectApiError('permission_error: access denied');
      expect(result.isApiError).toBe(true);
      expect(result.errorType).toBe('auth');
    });

    it('detects insufficient quota errors', () => {
      const result = detectApiError('insufficient quota for this request');
      expect(result.isApiError).toBe(true);
      expect(result.errorType).toBe('quota');
    });

    it('detects container exit code 1', () => {
      const result = detectApiError('Claude Code process exited with code 1');
      expect(result.isApiError).toBe(true);
    });

    it('returns false for non-API errors', () => {
      const result = detectApiError('network connection failed');
      expect(result.isApiError).toBe(false);
      expect(result.errorType).toBe('unknown');
      expect(result.userMessage).toBe('');
    });

    it('returns false for null/undefined input', () => {
      expect(detectApiError(null).isApiError).toBe(false);
      expect(detectApiError(undefined).isApiError).toBe(false);
      expect(detectApiError('').isApiError).toBe(false);
    });

    it('handles unknown API error types', () => {
      const result = detectApiError('some unknown API error pattern not matched');
      expect(result.isApiError).toBe(false);
    });

    it('truncates long error messages in user message', () => {
      const longError = 'a'.repeat(500);
      const result = detectApiError(`usage limit ${longError}`);
      expect(result.userMessage.length).toBeLessThan(600);
    });
  });

  describe('formatTaskApiErrorMessage', () => {
    it('formats task API error message', () => {
      const message = formatTaskApiErrorMessage(
        '每天早上9点提醒我开会',
        'usage limit exceeded for this billing cycle',
      );

      expect(message).toContain('配额已用尽');
      expect(message).toContain('每天早上9点提醒我开会');
      expect(message).toContain('已暂停');
      expect(message).toContain('手动恢复');
    });

    it('truncates long task prompts', () => {
      const longPrompt = 'a'.repeat(200);
      const message = formatTaskApiErrorMessage(longPrompt, 'rate limit exceeded');

      expect(message).toContain('aaa...');
      expect(message.length).toBeLessThan(600);
    });
  });
});