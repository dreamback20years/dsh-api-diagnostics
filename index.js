import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const tag = '[api-diagnostics]'

export function createErrorLog(file, limit = 5 * 1024 * 1024) {
  return (entry) => {
    const line = `${JSON.stringify(entry)}\n`
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    let size = 0
    try { size = statSync(file).size } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (size > 0 && size + Buffer.byteLength(line) > limit) renameSync(file, `${file}.1`)
    appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
  }
}

function clean(value, max = 640) {
  if (typeof value !== 'string') return ''
  const text = value
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL hidden]')
    .replace(/\b(?:Bearer|Basic)\s+[\w+./=~-]+/gi, '[credential hidden]')
    .replace(/(["']?(?:authorization|(?:x[-_])?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|secret|cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\]}]+)/gi, '$1[hidden]')
    .replace(/\b(?:sk|rk|pk|ghp|gho|xox[baprs])[-_][\w-]{4,}/gi, '[credential hidden]')
    .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, '[long value hidden]')
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const hints = {
  AUTH: '鉴权失败：检查对应供应商的 API Key、账号状态和访问权限。',
  QUOTA: '配额不足：检查账户余额、配额或用量限制。',
  ACCOUNT_QUOTA: '账户配额不足：检查余额或套餐用量。',
  RATE_LIMIT: '请求受限：稍后重试，或降低并发。',
  TIMEOUT: '请求超时：检查网络连接、代理或供应商状态。',
  NETWORK: '网络请求失败：检查网络、DNS、代理和 API 地址。',
}

function hint(code, status) {
  if (code === 'AUTH' || status === 401) return hints.AUTH
  if (status === 403) return '访问被拒绝：检查账号、项目和模型权限。'
  return Object.hasOwn(hints, code) ? hints[code]
    : status === 400 ? '请求被拒绝：检查模型参数或输入限制。'
    : status === 404 ? '找不到资源：检查模型 ID 和 API 地址。'
    : status === 429 ? hints.RATE_LIMIT
    : status >= 500 ? '供应商或网关异常：检查服务状态后重试。'
    : ''
}

export function apply(ctx) {
  const file = join(homedir(), '.dsh', 'logs', 'api-diagnostics.jsonl')
  return registerDiagnostics(ctx, createErrorLog(file))
}

export function registerDiagnostics(ctx, writeError) {
  ctx.on('llm/stream', async function* (options, next) {
    for await (const chunk of next()) {
      if (chunk.type !== 'finish' || chunk.reason.kind !== 'error' || options.signal?.aborted) {
        yield chunk
        continue
      }
      const { failure } = chunk.reason
      const { code, status, requestId, providerRetryAfterMs } = failure
      const auth = code === 'AUTH' || status === 401 || status === 403
      const fields = [
        clean(options.provider, 80) && `Provider: ${clean(options.provider, 80)}`,
        clean(options.model, 120) && `Model: ${clean(options.model, 120)}`,
        clean(code, 60) && `Code: ${clean(code, 60)}`,
        Number.isInteger(status) && `HTTP ${status}`,
        typeof requestId === 'string' && /^[\w.:/-]{1,128}$/.test(requestId) && `Request ID: ${requestId}`,
        Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0 && `Retry-After: ${Math.ceil(providerRetryAfterMs / 1000)}s`,
      ].filter(Boolean)
      const message = [hint(code, status), auth ? '' : clean(failure.message), fields.join(' · ')].filter(Boolean).join(' | ')
      const id = typeof requestId === 'string' && /^[\w.:/-]{1,128}$/.test(requestId) ? requestId : undefined
      const retryAfterMs = Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0 ? providerRetryAfterMs : undefined
      const advice = hint(code, status)
      // A disk error must not mask the upstream failure or change retry behavior.
      try {
        writeError({
          timestamp: new Date().toISOString(),
          provider: clean(options.provider, 80),
          model: clean(options.model, 120),
          code: clean(code, 60),
          httpStatus: Number.isInteger(status) ? status : undefined,
          requestId: id,
          retryAfterMs,
          reason: auth ? advice : clean(failure.message, 4096) || advice || 'No upstream error message',
          advice: advice || undefined,
        })
      } catch (error) {
        try { ctx.logger.warn(`${tag} 无法写入文件日志 (${clean(error?.code, 32) || 'UNKNOWN'})`) } catch {}
      }
      try { ctx.logger.warn(`${tag} ${message}`) } catch {}
      yield { ...chunk, reason: { ...chunk.reason, failure: { ...failure, message } } }
    }
  })
}
