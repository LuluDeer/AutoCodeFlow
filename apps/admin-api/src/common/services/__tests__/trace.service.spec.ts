import { TraceService } from '../trace.service';

describe('TraceService', () => {
  let service: TraceService;

  beforeEach(() => {
    service = new TraceService();
  });

  describe('traceId getter/setter', () => {
    it('should generate a UUID on construction when no async context exists', () => {
      const id = service.traceId;
      // UUID v4 pattern
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('should allow setting a custom traceId', () => {
      service.traceId = 'my-trace-001';
      expect(service.traceId).toBe('my-trace-001');
    });
  });

  describe('runWithTrace / getCurrentTraceId', () => {
    it('should return undefined when no trace context is active', () => {
      // Outside any runWithTrace call the storage has nothing
      expect(TraceService.getCurrentTraceId()).toBeUndefined();
    });

    it('should expose the traceId inside a runWithTrace callback', () => {
      let captured: string | undefined;
      TraceService.runWithTrace('trace-xyz', () => {
        captured = TraceService.getCurrentTraceId();
      });
      expect(captured).toBe('trace-xyz');
    });

    it('should restore previous context after runWithTrace exits', () => {
      TraceService.runWithTrace('outer', () => {
        TraceService.runWithTrace('inner', () => {/* noop */});
        expect(TraceService.getCurrentTraceId()).toBe('outer');
      });
    });

    it('new TraceService() inside runWithTrace should pick up the context traceId', () => {
      let inner: TraceService | undefined;
      TraceService.runWithTrace('ctx-trace-42', () => {
        inner = new TraceService();
      });
      expect(inner!.traceId).toBe('ctx-trace-42');
    });
  });

  describe('attachToAxiosConfig', () => {
    it('should add X-Trace-Id header to axios config', () => {
      service.traceId = 'header-trace-1';
      const fakeHeaders = {
        set: jest.fn(),
      };
      const config: any = { headers: fakeHeaders };
      const result = service.attachToAxiosConfig(config);
      expect(fakeHeaders.set).toHaveBeenCalledWith('X-Trace-Id', 'header-trace-1');
      expect(result).toBe(config);
    });
  });

  describe('getTraceHeaders', () => {
    it('should return a headers object with the current traceId', () => {
      service.traceId = 'hdr-999';
      expect(service.getTraceHeaders()).toEqual({ 'X-Trace-Id': 'hdr-999' });
    });
  });
});
