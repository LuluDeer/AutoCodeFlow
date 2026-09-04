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
 *
 * N37 (round-10): the store also carries the channel's `enabled` flag
 * (parallel map, kept OUT of the config record so `get()` stays the pure raw
 * config the other channels read). The webhook channel only lets a SAVED url
 * take effect while the channel is enabled — a disabled channel's config must
 * not silently reroute traffic. Entries published without an explicit flag
 * (e.g. test fixtures seeding config directly) default to enabled.
 */
@Injectable()
export class ChannelConfigStore {
  private readonly configs = new Map<string, Record<string, string>>();
  private readonly enabledFlags = new Map<string, boolean>();

  /** Raw (unmasked) config previously saved for a channel key, if any. */
  get(key: string): Record<string, string> | undefined {
    return this.configs.get(key);
  }

  /**
   * N37: whether the channel's saved config may take effect on the send
   * path. Defaults to `true` when no flag was ever published for the key.
   */
  isEnabled(key: string): boolean {
    return this.enabledFlags.get(key) ?? true;
  }

  /**
   * Store a snapshot of the channel config (shallow copy, raw values).
   * `enabled` is optional: when omitted the previously published flag (or
   * the default) is kept — callers that only rotate config (testChannel's
   * temporary override) pass it explicitly to pin the test-time state.
   */
  set(key: string, config: Record<string, string>, enabled?: boolean): void {
    this.configs.set(key, { ...config });
    if (enabled !== undefined) this.enabledFlags.set(key, enabled);
  }

  /**
   * R8 (N29): drop a stored snapshot — used by testChannel to restore the
   * pre-override state after a temporary unsaved-config test send.
   * N37: the enabled flag is dropped with it (back to the default).
   */
  delete(key: string): void {
    this.configs.delete(key);
    this.enabledFlags.delete(key);
  }
}
