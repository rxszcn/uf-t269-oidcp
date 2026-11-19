// 以用户标识（accountId）为界的会话注册表。
//
// 适配器契约只提供按 jti 主键与按 uid 二级索引的查询能力，没有“按 accountId 枚举会
// 话”的接口，也不应为修复注销完整性而给所有自定义适配器强加新接口。这里在进程内维
// 护 accountId -> Set(uid) 的索引：会话落库（save）且带有 accountId 时登记，会话终结
// （destroy）时摘除。注销据此枚举同一用户标识下的全部逻辑会话并逐行终结，清扫范围
// 严格限定在该 accountId 的 uid 集合内，天然不触碰其他用户标识的会话行。
//
// 注册表自身的读改写由一把账户级临界区保护；调用方（lib/shared/session.js 与
// lib/models/session.js）始终在 uid 临界区内调用本模块，锁序固定为 uid 锁 -> 账户
// 锁，不允许反向获取，因此不存在死锁路径。

import withSessionLock from './session_lock.js';

const accountSessions = new Map();

const accountKey = (accountId) => `account:${accountId}`;

// 登记一个属于 accountId 的逻辑会话（以稳定 uid 标识）。幂等：同一 uid 重复登记不
// 会产生重复条目。
export async function registerSession(accountId, uid) {
  if (!accountId || !uid) {
    return;
  }

  await withSessionLock(accountKey(accountId), async () => {
    let uids = accountSessions.get(accountId);
    if (!uids) {
      uids = new Set();
      accountSessions.set(accountId, uids);
    }
    uids.add(uid);
  });
}

// 摘除一个逻辑会话的登记。注销或单行销毁时调用；摘除后若该账户已无任何会话则回收
// 整个账户条目，避免 Map 随已注销用户无限增长。
export async function unregisterSession(accountId, uid) {
  if (!accountId || !uid) {
    return;
  }

  await withSessionLock(accountKey(accountId), async () => {
    const uids = accountSessions.get(accountId);
    if (!uids) {
      return;
    }
    uids.delete(uid);
    if (uids.size === 0) {
      accountSessions.delete(accountId);
    }
  });
}

// 快照某一用户标识当前登记的全部逻辑会话 uid。返回数组副本，调用方可在锁外据此刻
// 度逐行终结，无需长期持有账户锁。
export async function listSessionUids(accountId) {
  if (!accountId) {
    return [];
  }

  return withSessionLock(accountKey(accountId), async () => [
    ...(accountSessions.get(accountId) ?? []),
  ]);
}
