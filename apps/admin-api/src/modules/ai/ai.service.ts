import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  constructor(private config: ConfigService) {}

  async analyzeFailure(task: any, logs: string): Promise<string> {
    const provider = this.config.get<string>('ai.provider', 'disabled');
    if (provider === 'disabled') return '';
    const prompt = `你是自动化任务分析助手。任务"${task.name}"(${task.runtime})执行失败，请分析原因并给出修复建议。\n\n错误日志:\n${logs.slice(0, 3000)}\n\n请用中文回答：\n**失败原因：** ...\n**修复建议：** ...`;
    try {
      if (provider === 'openai') return await this.callOpenAI(prompt);
      if (provider === 'ollama') return await this.callOllama(prompt);
    } catch (e) { this.logger.warn(`AI error: ${e.message}`); }
    return '';
  }

  private async callOpenAI(prompt: string) {
    // Q4: add timeout so a non-responsive LLM doesn't block the BullMQ worker indefinitely
    const r = await axios.post('https://api.openai.com/v1/chat/completions',
      { model: this.config.get('ai.openaiModel', 'gpt-4o-mini'), messages: [{ role: 'user', content: prompt }], max_tokens: 500 },
      { headers: { Authorization: `Bearer ${this.config.get('ai.openaiApiKey')}` }, timeout: 30_000 });
    return r.data.choices[0].message.content;
  }

  private async callOllama(prompt: string) {
    // Q4: add timeout
    const r = await axios.post(`${this.config.get('ai.ollamaHost', 'http://localhost:11434')}/api/generate`,
      { model: this.config.get('ai.ollamaModel', 'llama3'), prompt, stream: false },
      { timeout: 60_000 });
    return r.data.response;
  }
}
