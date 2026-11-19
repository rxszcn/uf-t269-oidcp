import { positiveInteger } from '../helpers/configuration_result.js';
import withSessionLock, { acquire } from '../helpers/session_lock.js';
import instance from '../helpers/weak_cache.js';

export default async function sessionHandler(ctx, next) {
  const { provider } = ctx.oidc;
  const cookies = ctx.oidc
    ? ctx.oidc.cookies : provider.createContext(ctx.req, ctx.res).cookies;
  cookies.secure = !cookies.secure && ctx.secure ? true : cookies.secure;

  // is there supposed to be a session bound? generate if not
  const cookieSessionId = cookies.get(
    provider.cookieName('session'),
    instance(provider).configuration.cookies.long,
  );

  // 同一逻辑会话的请求必须串行进入“装载 -> 变更 -> 保存/销毁”临界区。会话建立前没有
  // 稳定 uid，先以 cookie 中的 jti 为键排队；会话一旦装载就切换到生命周期内不变的
  // uid，使 jti 轮换（resetIdentifier）前后的请求仍互斥，从根上消除并发授权恢复把同一
  // uid 拆成多行的窗口。新会话（无 cookie）彼此无需互斥，不加锁。
  if (!cookieSessionId) {
    const session = await provider.Session.get(ctx);
    await runRequest(ctx, next, session);
    return;
  }

  const releaseCookieLock = await acquire(`jti:${cookieSessionId}`);
  try {
    const initial = await provider.Session.get(ctx);

    // 区分三种装载结果：
    //   1) 无 cookie 新建会话：new === true（本分支前已拦截，不会到这里）；
    //   2) cookie jti 失效（过期/销毁/被并发轮换）：instantiate({}) 产生的空会话，没有
    //      exp 等持久化字段，但构造器仍会生成新的 uid/jti；
    //   3) 装载到真实持久化会话：带 exp。
    // 因此用 exp 是否存在判断“是否真实持久化行”，不能用 uid（空会话也有 uid）或 new
    // （空会话的 new 是 undefined）。
    if (typeof initial.exp !== 'number') {
      // 空会话：没有可锁定的真实 uid，直接在入门锁内处理。resume 会按交互记录的 uid
      // 再做权威挂接（见 lib/actions/authorization/resume.js）。
      await runRequest(ctx, next, initial);
      return;
    }

    // 升级到以稳定 uid 为键的临界区。入门锁在这里即可放行：uid 锁的等待队列本身保证
    // 后续同 uid 请求互斥，且入门键是轮换前的旧 jti，持有更久只会无谓阻塞其他携带旧
    // cookie 的请求。
    releaseCookieLock();

    await withSessionLock(initial.uid, async () => {
      // 等待 uid 锁期间，前一个持锁请求可能已经轮换并销毁了 cookie 指向的 jti。重新装
      // 载权威行：优先按 uid 回读，避免拿着过期 jti 的副本再写一行；uid 也查不到（与注
      // 销交叠）时回退到 get() 已装载的空会话，由后续动作按既有“会话不存在”规则处理。
      const authoritative = await provider.Session.reconcileByUid(initial.uid);
      await runRequest(ctx, next, authoritative ?? initial);
    });
  } finally {
    // uid 升级路径上已提前放行；这里对未升级路径幂等补一次释放。
    releaseCookieLock();
  }
}

async function runRequest(ctx, next, session) {
  // 授权恢复路径在发现当前会话已被并发请求轮换时，可通过 attachSession 按交互记录的
  // 稳定 uid 重新挂接权威会话（见 lib/models/session.js 与 lib/actions/authorization/
  // resume.js）。挂接会重建 Proxy 并替换 ctx.oidc.session，下游在 await 之后重新读取即可。
  ctx.oidc.attachSession = (nextTarget) => {
    ctx.oidc.session = createSessionProxy(nextTarget);
  };

  ctx.oidc.session = createSessionProxy(session);

  try {
    await next();
  } finally {
    const sessionCookieName = ctx.oidc.provider.cookieName('session');
    const longRegExp = new RegExp(`^${sessionCookieName}(?:\\.sig)?=`);

    // refresh the session duration
    if ((!ctx.oidc.session.new || ctx.oidc.session.touched) && !ctx.oidc.session.destroyed) {
      let ttl = instance(ctx.oidc.provider).configuration.ttl.Session;

      if (typeof ttl === 'function') {
        ttl = ttl(ctx, ctx.oidc.session);
      }

      ttl = positiveInteger(ttl, 'ttl.Session');

      ctx.oidc.cookies.set(
        sessionCookieName,
        ctx.oidc.session.id,
        instance(ctx.oidc.provider).configuration.cookies.long,
      );
      await ctx.oidc.session.save(ttl);
    }

    let setCookie = ctx.response.get('set-cookie');
    if (setCookie) {
      if (typeof setCookie === 'string') {
        setCookie = [setCookie];
      }
      setCookie.forEach((cookie, index, ary) => {
        if (
          !cookie.includes('expires=Thu, 01 Jan 1970')
          && cookie.match(longRegExp)
          && !ctx.oidc.session.transient
          && ctx.oidc.session.exp
        ) {
          ary[index] += `; expires=${new Date(ctx.oidc.session.exp * 1000).toUTCString()}`;
        }
      });
    }
  }
}

// 直接以会话对象为 proxy target，所有元属性（instanceof、Object.keys、属性描述符、
// in 等）天然与原对象一致，无需自定义 trap，避免 proxy 不变量冲突。set trap 保留既有
// 的 touched/destroyed 联动与 accountId 非空字符串校验语义。
function createSessionProxy(session) {
  return new Proxy(session, {
    set(obj, prop, value) {
      switch (prop) {
        case 'touched':
          Reflect.defineProperty(obj, 'touched', { writable: true, value });
          break;
        case 'destroyed':
          Reflect.defineProperty(obj, 'destroyed', { configurable: false, writable: true, value });
          Reflect.defineProperty(obj, 'touched', { configurable: false, writable: false, value: false });
          break;
        default:
          if (prop === 'accountId' && (typeof value !== 'string' || !value)) {
            throw new TypeError(`accountId must be a non-empty string, got: ${typeof value}`);
          }
          Reflect.set(obj, prop, value);
          Reflect.defineProperty(obj, 'touched', { writable: true, value: true });
      }

      return true;
    },
  });
}
