// 会话级互斥锁。
//
// 同一浏览器的多个标签页共享同一个 OP 会话 cookie，门户前端在授权回调超时时会
// 自动重发恢复请求，重发与首次恢复因此可能在同一秒窗口内并发到达。授权恢复
// （resume）会对会话执行 resetIdentifier()，把会话行的主键 jti 轮换为新值并销毁旧
// 行，而会话的稳定标识 uid 保持不变。两个并发请求若各自装载、各自轮换并各自保存，
// 就会把同一个 uid 的会话拆成多行互相覆盖；接入 uid 唯一索引的适配器形态下，后到
// 的 upsert 还会以未捕获的唯一约束冲突收场。
//
// 这里以稳定标识（优先 uid，未建立会话时退化为 cookie 中的 jti）为键提供进程内的
// 串行化临界区，使同一逻辑会话的“装载 -> 变更 -> 保存/销毁”整体互斥。多进程部署
// 的跨进程竞争由 lib/models/session.js 中对唯一约束冲突的可重试收束兜底。

const chains = new Map();

// 等待同一键上前一个临界区结束，返回该键临界区的“放行函数”。
// 放行函数幂等：只应在持有它的临界区结束时调用一次，重复调用不会破坏后续排队者。
export function acquire(key) {
  const previous = chains.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  chains.set(key, current);

  let released = false;
  const unlock = () => {
    if (released) {
      return;
    }
    released = true;
    // 没有后来者排队时回收锁条目，避免 Map 随会话标识无限增长。
    if (chains.get(key) === current) {
      chains.delete(key);
    }
    release();
  };

  return previous.then(() => unlock);
}

// 在以 key 标识的互斥临界区内执行 work；无论 work 成功与否都放行下一个排队者。
export default async function withSessionLock(key, work) {
  const release = await acquire(key);
  try {
    return await work();
  } finally {
    release();
  }
}
