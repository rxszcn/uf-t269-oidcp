import MemoryAdapter from '../../lib/adapters/memory_adapter.js';
import getConfig from '../default.config.js';

// 可枚举、可注入唯一约束的 Session 适配器。
// 既有 MemoryAdapter 的存储是不支持枚举的 LRU，无法在测试侧按 accountId 统计存活行；
// 这里以普通 Map 承载全部模型，并对 Session 模型保留 findByUid 二级索引语义，额外提供：
//   - liveSessionRows(accountId)：统计某用户标识当前存活的会话行数（验收读数）
//   - enforceUidUnique：开启后对“同一 uid 第二个不同 jti 的 upsert”抛出唯一约束冲突，
//     模拟按比例灰度放量的 uid 唯一索引适配器形态。
class TrackingSessionAdapter extends MemoryAdapter {
  static #live = new Map();

  static #instances = new Map();

  // biome-ignore lint/correctness/noUnreachableSuper: intentional caching of adapter instances by name
  constructor(name) {
    // 与 test/models.js 的 TestAdapter 同样按模型名缓存实例，使 base_model 的适配器
    // 缓存与测试侧拿到的是同一个带共享存储的对象。
    // biome-ignore lint/correctness/noConstructorReturn: intentional caching of adapter instances by name
    if (TrackingSessionAdapter.#instances.has(name)) return TrackingSessionAdapter.#instances.get(name);
    super(name, TrackingSessionAdapter.#live);
    if (name === 'Session') {
      this.enforceUidUnique = false;
    }
    TrackingSessionAdapter.#instances.set(name, this);
  }

  static sessionAdapter() {
    return TrackingSessionAdapter.#instances.get('Session');
  }

  static liveSessionRows(accountId) {
    let count = 0;
    for (const [key, payload] of TrackingSessionAdapter.#live) {
      if (key.startsWith('Session:') && payload && payload.accountId === accountId) {
        count += 1;
      }
    }
    return count;
  }

  async upsert(id, payload, expiresIn) {
    if (this.model === 'Session' && this.enforceUidUnique && payload.uid) {
      for (const [key, existing] of TrackingSessionAdapter.#live) {
        if (
          key.startsWith('Session:')
          && key !== this.key(id)
          && existing.uid === payload.uid
        ) {
          const err = new Error('duplicate key value violates unique constraint "session_uid_idx"');
          err.code = '23505';
          throw err;
        }
      }
    }
    return super.upsert(id, payload, expiresIn);
  }

  static reset() {
    TrackingSessionAdapter.#live.clear();
    const session = TrackingSessionAdapter.#instances.get('Session');
    if (session) {
      session.enforceUidUnique = false;
    }
  }
}

const baseConfig = getConfig();

const config = {
  ...baseConfig,
  adapter: (name) => new TrackingSessionAdapter(name),
};

export { config, TrackingSessionAdapter };

export const clients = [{
  client_id: 'client',
  client_secret: 'secret',
  grant_types: ['authorization_code'],
  response_types: ['code'],
  redirect_uris: ['https://client.example.com/cb'],
}];

export default {
  config,
  clients,
};
