/**
 * AdapterRegistry — additive registry that routes a platform id to its adapter
 * (Foundation Req 9.3, 9.4). Registration never overwrites previously-registered
 * adapters for other platforms; lookups for an unknown platform throw
 * UnsupportedPlatformError (-> 400).
 */
import type { Capability, PlatformAdapter, PlatformId } from './adapter';
import { UnsupportedOperationError, UnsupportedPlatformError } from './adapter';

export class AdapterRegistry {
  private readonly adapters = new Map<PlatformId, PlatformAdapter>();

  /**
   * Register an adapter. Additive: registering one platform leaves every other
   * registered platform untouched. Re-registering the same platform replaces
   * only that platform's entry.
   */
  register(adapter: PlatformAdapter): this {
    this.adapters.set(adapter.platform, adapter);
    return this;
  }

  /** Resolve an adapter or throw UnsupportedPlatformError (Req 9.4). */
  get(platform: PlatformId): PlatformAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new UnsupportedPlatformError(platform);
    }
    return adapter;
  }

  has(platform: PlatformId): boolean {
    return this.adapters.has(platform);
  }

  /** All registered platform ids (insertion order). */
  list(): PlatformId[] {
    return [...this.adapters.keys()];
  }
}

/**
 * Base helper for concrete adapters. Centralizes the capability matrix and the
 * "unimplemented capability -> UnsupportedOperationError" behavior so each
 * adapter only implements the operations it actually supports (Req 9.5).
 */
export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract readonly platform: PlatformId;
  abstract readonly capabilities: ReadonlySet<Capability>;

  supports(capability: Capability): boolean {
    return this.capabilities.has(capability);
  }

  /**
   * Adapters call this at the top of an operation they do not implement so the
   * caller receives a consistent UnsupportedOperationError (-> 400).
   */
  protected unsupported(operation: Capability): never {
    throw new UnsupportedOperationError(this.platform, operation);
  }

  /** Guard: throw if the requested capability is not in this adapter's matrix. */
  protected assertSupported(operation: Capability): void {
    if (!this.supports(operation)) {
      this.unsupported(operation);
    }
  }

  abstract publish(...args: Parameters<PlatformAdapter['publish']>): ReturnType<PlatformAdapter['publish']>;
  abstract collectAnalytics(
    ...args: Parameters<PlatformAdapter['collectAnalytics']>
  ): ReturnType<PlatformAdapter['collectAnalytics']>;
}
