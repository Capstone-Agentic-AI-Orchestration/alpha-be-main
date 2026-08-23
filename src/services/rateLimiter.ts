import PQueue from 'p-queue';
import { PROVIDER_CONCURRENCY } from '../config/constants.js';
import { ModelProvider } from '../models/index.js';

export class RateLimiterService {
  private queues = {
    anthropic: new PQueue({
      concurrency: PROVIDER_CONCURRENCY.ANTHROPIC.concurrency,
      interval: PROVIDER_CONCURRENCY.ANTHROPIC.interval,
      intervalCap: PROVIDER_CONCURRENCY.ANTHROPIC.intervalCap
    }),
    gemini: new PQueue({
      concurrency: PROVIDER_CONCURRENCY.GEMINI.concurrency,
      interval: PROVIDER_CONCURRENCY.GEMINI.interval,
      intervalCap: PROVIDER_CONCURRENCY.GEMINI.intervalCap
    }),
    openai: new PQueue({
      concurrency: PROVIDER_CONCURRENCY.OPENAI.concurrency,
      interval: PROVIDER_CONCURRENCY.OPENAI.interval,
      intervalCap: PROVIDER_CONCURRENCY.OPENAI.intervalCap
    })
  };

  /**
   * Acquire execution slot for a specific provider
   */
  async acquireSlot<T>(provider: ModelProvider, task: () => Promise<T>): Promise<T> {
    const queue = this.getQueueForProvider(provider);
    return queue.add(() => this.withRetry(task)) as Promise<T>;
  }

  private getQueueForProvider(provider: ModelProvider): PQueue {
    switch (provider) {
      case 'Anthropic':
        return this.queues.anthropic;
      case 'Google Gemini':
        return this.queues.gemini;
      case 'OpenAI':
        return this.queues.openai;
      default:
        return this.queues.anthropic;
    }
  }

  /**
   * Exponential backoff with randomized jitter on HTTP 429
   */
  async withRetry<T>(fn: () => Promise<T>, maxRetries = 4): Promise<T> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        return await fn();
      } catch (err: any) {
        const isRateLimit = err?.status === 429 ||
          err?.statusCode === 429 ||
          (err?.message && err.message.toLowerCase().includes('rate limit'));

        if (isRateLimit && attempt < maxRetries - 1) {
          attempt++;
          const baseDelay = 1000 * Math.pow(2, attempt);
          const maxDelay = 30000;
          const jitter = Math.random() * Math.min(maxDelay, baseDelay);
          await new Promise(r => setTimeout(r, jitter));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Exceeded maximum retries (${maxRetries}) due to rate limiting.`);
  }
}

export const rateLimiterService = new RateLimiterService();
