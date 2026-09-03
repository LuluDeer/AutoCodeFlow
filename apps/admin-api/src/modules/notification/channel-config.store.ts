import { Injectable } from "@nestjs/common";

/**
 * V1 (round-7): single source of truth for channel configs saved through
 * `PATCH /notification/channels/:key`. Before this existed the admin config
 * surface was write-only — channels resolved their outbound URL/credentials
 * exclusively from `ConfigService` (env), so a saved webhookUrl/SMTP config
 * never affected `send()`/`sendTest()`.
 *
 * Resolution order for every channel is now: **saved config first, env as
 * fallback default** (see the individual `*.channel.ts` implementations).
 * When nothing was ever saved (or the saved value is empty) the previous env
 * behavior is preserved unchanged.
 *
 * Values here are RAW (unmasked). The N11 masking (`password` → `'***'`)
 * applies only to the GET/PATCH response surface in NotificationConfigService,
 * and the `'***'` sentinel is filtered out on write — so the send path always
 * sees the real secret, never the masked echo.
 *
 * In-memory by design for now (same lifecycle as the previous
 * `NotificationConfigService.channelConfigs`); DB persistence is a follow-up.
 */
@Injectable()
export class ChannelConfigStore {
  private readonly configs = new Map<string, Record<string, string>>();

  /** Raw (unmasked) config previously saved for a channel key, if any. */
  get(key: string): Record<string, string> | undefined {
    return this.configs.get(key);
  }

  /** Store a snapshot of the channel config (shallow copy, raw values). */
  set(key: string, config: Record<string, string>): void {
    this.configs.set(key, { ...config });
  }

  /**
   * R8 (N29): drop a stored snapshot — used by testChannel to restore the
   * pre-override state after a temporary unsaved-config test send.
   */
  delete(key: string): void {
    this.configs.delete(key);
  }
}
