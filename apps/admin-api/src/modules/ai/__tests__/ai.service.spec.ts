import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../ai.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('AiService', () => {
  let service: AiService;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AiService>(AiService);
    configService = module.get(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('analyzeFailure', () => {
    it('should return empty string when provider is disabled', async () => {
      configService.get.mockReturnValue('disabled');
      const result = await service.analyzeFailure({ name: 'test', runtime: 'python' }, 'error log');
      expect(result).toBe('');
    });

    it('should call OpenAI and return response when provider is openai', async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === 'ai.provider') return 'openai';
        if (key === 'ai.openaiModel') return 'gpt-4o-mini';
        if (key === 'ai.openaiApiKey') return 'test-key';
        return defaultVal;
      });

      mockedAxios.post = jest.fn().mockResolvedValue({
        data: { choices: [{ message: { content: 'AI analysis result' } }] },
      });

      const result = await service.analyzeFailure(
        { name: 'my-task', runtime: 'node' },
        'Some error log',
      );
      expect(result).toBe('AI analysis result');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({ model: 'gpt-4o-mini' }),
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('should call Ollama and return response when provider is ollama', async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === 'ai.provider') return 'ollama';
        if (key === 'ai.ollamaHost') return 'http://localhost:11434';
        if (key === 'ai.ollamaModel') return 'llama3';
        return defaultVal;
      });

      mockedAxios.post = jest.fn().mockResolvedValue({
        data: { response: 'Ollama analysis' },
      });

      const result = await service.analyzeFailure(
        { name: 'task', runtime: 'python' },
        'traceback error',
      );
      expect(result).toBe('Ollama analysis');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.objectContaining({ model: 'llama3', stream: false }),
        expect.objectContaining({ timeout: 60_000 }),
      );
    });

    it('should return empty string when AI call throws', async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === 'ai.provider') return 'openai';
        if (key === 'ai.openaiApiKey') return 'bad-key';
        return defaultVal;
      });

      mockedAxios.post = jest.fn().mockRejectedValue(new Error('Network error'));

      const result = await service.analyzeFailure(
        { name: 'task', runtime: 'node' },
        'error log',
      );
      expect(result).toBe('');
    });
  });

  describe('sanitizeLogs (via analyzeFailure)', () => {
    it('should redact environment variable assignments from logs', async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === 'ai.provider') return 'openai';
        if (key === 'ai.openaiApiKey') return 'test-key';
        return defaultVal;
      });

      let capturedPrompt = '';
      mockedAxios.post = jest.fn().mockImplementation((_url, body: any) => {
        capturedPrompt = body.messages[0].content;
        return Promise.resolve({
          data: { choices: [{ message: { content: 'ok' } }] },
        });
      });

      await service.analyzeFailure(
        { name: 'task', runtime: 'node' },
        'DB_PASSWORD=supersecret API_KEY=abc123xyz',
      );

      expect(capturedPrompt).not.toContain('supersecret');
      expect(capturedPrompt).toContain('[REDACTED]');
    });

    it('should redact Bearer tokens from logs', async () => {
      configService.get.mockImplementation((key: string, defaultVal?: any) => {
        if (key === 'ai.provider') return 'openai';
        if (key === 'ai.openaiApiKey') return 'test-key';
        return defaultVal;
      });

      let capturedPrompt = '';
      mockedAxios.post = jest.fn().mockImplementation((_url, body: any) => {
        capturedPrompt = body.messages[0].content;
        return Promise.resolve({
          data: { choices: [{ message: { content: 'ok' } }] },
        });
      });

      await service.analyzeFailure(
        { name: 'task', runtime: 'node' },
        'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
      );

      expect(capturedPrompt).not.toContain('eyJhbGci');
    });
  });
});
