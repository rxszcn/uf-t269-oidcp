import epochTime from '../helpers/epoch_time.js';
import { SessionNotFound } from '../helpers/errors.js';
import nanoid from '../helpers/nanoid.js';
import {
  listSessionUids, registerSession, unregisterSession,
} from '../helpers/session_registry.js';
import instance from '../helpers/weak_cache.js';

// 识别适配器抛出的“uid 唯一索引约束冲突”。适配器实现各自对接不同存储，错误形态不
// 统一，这里按常见后端（Postgres/MySQL/SQLite/Mongo/LDAP 等）公开的 code/errno/错误
// 名与消息特征做保守匹配。命中时说明同一 uid 的另一行已经落库，当前请求不能再以
// 未捕获异常（最终渲染为 500）收场，而要转入可重试的收束分支。
function isUniqueConstraintError(err) {
  if (!err || typeof err !== 'object') {
    return false;
  }

  if (['SQLITE_CONSTRAINT_UNIQUE', '23505', 'ER_DUP_ENTRY', '11000'].includes(err.code)) {
    return true;
  }

  if ([1062, 11000].includes(err.errno)) {
    return true;
  }

  if (typeof err.name === 'string' && /unique/i.test(err.name)) {
    return true;
  }

  if (typeof err.message === 'string'
    && /duplicate key|unique constraint|duplicate entry|e11000/i.test(err.message)) {
    return true;
  }

  return false;
}

export default (provider) => class Session extends instance(provider).BaseModel {
  constructor(payload) {
    super(payload);
    if (!payload) {
      Object.defineProperty(this, 'new', { value: true });
    }
    this.uid = this.uid || nanoid();
    this.jti = this.jti || nanoid();
  }

  get id() {
    return this.jti;
  }

  set id(value) {
    this.jti = value;
  }

  static get IN_PAYLOAD() {
    return [
      ...super.IN_PAYLOAD,
      'uid',
      'acr',
      'amr',
      'accountId',
      'loginTs',
      'transient',
      'state',
      'authorizations',
    ];
  }

  static async findByUid(uid) {
    const stored = await this.adapter.findByUid(uid);
    if (!stored) {
      return undefined;
    }
    try {
      const payload = await this.verify(stored);
      return this.instantiate(payload);
    } catch {
      return undefined;
    }
  }

  static async get(ctx) {
    const cookies = ctx.oidc
      ? ctx.oidc.cookies : provider.createContext(ctx.req, ctx.res).cookies;
    cookies.secure = !cookies.secure && ctx.secure ? true : cookies.secure;

    // is there supposed to be a session bound? generate if not
    const cookieSessionId = cookies.get(
      provider.cookieName('session'),
      instance(provider).configuration.cookies.long,
    );

    let session;

    if (cookieSessionId) {
      session = await this.find(cookieSessionId);
    }

    if (!session) {
      if (cookieSessionId) {
        // underlying session was removed since we have a session id in cookie, let's assign an
        // empty data so that session.new is not true and cookie will get written even if nothing
        // gets written to it
        session = this.instantiate({});
      } else {
        session = this.instantiate();
      }
    }

    if (ctx.oidc instanceof provider.OIDCContext) {
      ctx.oidc.entity('Session', session);
    }

    return session;
  }

  async save(ttl) {
    if (typeof ttl !== 'number') {
      throw new TypeError('"ttl" argument must be a number');
    }
    // one by one adapter ops to allow for uid to have a unique index
    if (this.oldId) {
      await this.adapter.destroy(this.oldId);
    }

    try {
      const result = await super.save(ttl);

      this.touched = false;

      // 会话行已权威落库，登记进账户级注册表，使注销能够枚举并终结该用户标识下的
      // 全部逻辑会话。登记按 uid 去重，jti 轮换（uid 不变）重复登记无副作用。
      if (this.accountId) {
        await registerSession(this.accountId, this.uid);
      }

      return result;
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }

      // 唯一索引适配器形态下，并发的授权恢复可能在跨进程（进程内互斥锁无法覆盖）
      // 同时完成：另一个请求已经把同一 uid 的新会话行落库。此时本行永远无法成为该
      // uid 的唯一存活行，先把自己这次轮换产生的孤儿行回收，再以可重试错误收束，
      // 绝不让原始约束冲突冒泡成未捕获的 500。
      if (this.oldId && this.oldId !== this.jti) {
        await this.adapter.destroy(this.jti).catch(() => {});
      }

      throw new SessionNotFound('session was concurrently rotated, retry the request', {
        cause: err,
      });
    }
  }

  // 并发协调：以 uid 为稳定标识重新装载当前权威会话行。授权恢复在临界区内完成会话
  // 装载后，若 cookie 指向的 jti 已被并发请求轮换销毁，则按 uid 回读权威行；uid 也
  // 查不到（例如与注销交叠、会话已终结）时返回 undefined，由调用方走既有的“会话不
  // 存在”分支，而不是基于过期 jti 新建重复会话行。
  static async reconcileByUid(uid) {
    return this.findByUid(uid);
  }

  // 授权恢复专用：交互记录里保存着发起交互时会话的稳定 uid。并发恢复时当前请求可能
  // 因 cookie 的 jti 已被前一个请求轮换而只装载到一个新建的空会话（uid 已变），此方法
  // 按交互记录的 uid 回读权威会话并把调用方的会话代理重新挂接到它，使后续 resetIdentifier
  // 与保存都作用在唯一的权威行上。回读不到（与注销交叠）时返回 false，由调用方维持既有
  // 的“会话不存在/不匹配”错误分支。
  static async reattachByUid(ctx, uid) {
    if (!uid) {
      return false;
    }
    const authoritative = await this.findByUid(uid);
    if (!authoritative) {
      return false;
    }
    if (typeof ctx.oidc.attachSession === 'function') {
      ctx.oidc.attachSession(authoritative);
    }
    if (ctx.oidc instanceof provider.OIDCContext) {
      ctx.oidc.entity('Session', authoritative);
    }
    return true;
  }

  // 注销清扫：终结同一 uid 下除当前 jti 外的残留会话行。串行场景下不存在残留行，该
  // 方法不产生任何额外适配器调用；并发拆分出的孤儿行会在这里被一并终结。清扫以 uid
  // 为界，不会触及其他 uid（即其他用户标识或其他浏览器会话）的会话行。
  async destroySiblings() {
    if (!this.uid) {
      return;
    }

    const stored = await this.constructor.findByUid(this.uid);
    if (stored && stored.jti !== this.jti) {
      await this.adapter.destroy(stored.jti);
      if (stored.accountId) {
        await unregisterSession(stored.accountId, stored.uid);
      }
    }
  }

  // 账户级全终结：注销入口调用。枚举注册表中该 accountId 的全部逻辑会话 uid，逐行
  // 终结后摘除登记。范围严格限定在本 accountId 的 uid 集合，不会波及其他用户标识的
  // 会话行；注册表中已自然过期或被并发销毁的 uid 在 findByUid 处返回 undefined 时安静
  // 跳过，保证与在途授权恢复交叠时也能收束而不抛错。
  static async destroyAccountSessions(accountId) {
    if (!accountId) {
      return;
    }

    const uids = await listSessionUids(accountId);
    for (const uid of uids) {
      // 串行化每个 uid 的销毁，避免与同 uid 的在途授权恢复并发写。
      // eslint-disable-next-line no-await-in-loop
      const stored = await this.findByUid(uid);
      if (!stored) {
        // eslint-disable-next-line no-await-in-loop
        await unregisterSession(accountId, uid);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await this.adapter.destroy(stored.jti);
      // eslint-disable-next-line no-await-in-loop
      await unregisterSession(accountId, uid);
    }
  }

  async persist() {
    if (typeof this.exp !== 'number') {
      throw new TypeError('persist can only be called on previously persisted Sessions');
    }
    return this.save(this.exp - epochTime());
  }

  async destroy() {
    await super.destroy();
    if (this.accountId) {
      await unregisterSession(this.accountId, this.uid);
    }
    this.destroyed = true;
  }

  resetIdentifier() {
    this.oldId = this.id;
    this.id = nanoid();
    this.touched = true;
  }

  authTime() {
    return this.loginTs;
  }

  past(age) {
    const maxAge = +age;

    if (this.loginTs) {
      return epochTime() - this.loginTs > maxAge;
    }

    return true;
  }

  authorizationFor(clientId, value) {
    // the call will not set, let's not modify the session object
    if (value === undefined && !this.authorizations) {
      return {};
    }

    this.authorizations = this.authorizations || {};
    if (!this.authorizations[clientId]) {
      this.authorizations[clientId] = {};
    }

    return this.authorizations[clientId];
  }

  sidFor(clientId, value) {
    const authorization = this.authorizationFor(clientId, value);

    if (value) {
      authorization.sid = value;
      return undefined;
    }

    return authorization.sid;
  }

  grantIdFor(clientId, value) {
    const authorization = this.authorizationFor(clientId, value);

    if (value) {
      authorization.grantId = value;
      return undefined;
    }

    return authorization.grantId;
  }

  ensureClientContainer(clientId) {
    if (!this.sidFor(clientId)) {
      this.sidFor(clientId, nanoid());
    }
  }

  loginAccount(details) {
    const {
      transient = false, accountId, loginTs = epochTime(), amr, acr,
    } = details;

    Object.assign(
      this,
      {
        accountId, loginTs, amr, acr,
      },
      transient ? { transient: true } : undefined,
    );
  }
};
