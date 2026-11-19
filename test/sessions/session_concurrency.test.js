import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { CookieAccessInfo } from 'cookiejar';
import { agent as supertest } from 'supertest';

import bootstrap from '../test_helper.js';
import { TrackingSessionAdapter } from './session_concurrency.config.js';

describe('session concurrency: concurrent authorization resume', () => {
  const fixture = {};

  before(
    bootstrap(import.meta.url, fixture, { config: 'session_concurrency' }),
    { timeout: 3000 },
  );
  beforeEach(() => TrackingSessionAdapter.reset(), { timeout: 3000 });

  const AUTH_QUERY = {
    client_id: 'client',
    response_type: 'code',
    scope: 'openid',
    redirect_uri: 'https://client.example.com/cb',
  };

  // 走一遍 devInteractions：发起授权 -> 按交互类型提交登录或同意 -> 返回 resume 路径。
  // 已登录会话上的新授权会落到 consent 交互，这里据渲染表单自适应，保证每次都拿到一条
  // 处于“待恢复”状态的独立交互。
  async function pendingResume(agent, accountId) {
    const authorize = await agent.get('/auth').query(AUTH_QUERY).expect(303);
    const interactionUrl = authorize.headers.location;

    const page = await agent.get(interactionUrl).expect(200);
    const isLogin = /name="prompt" value="login"/.test(page.text);

    await agent.post(interactionUrl)
      .send(isLogin ? { prompt: 'login', login: accountId } : { prompt: 'consent' })
      .type('form')
      .expect(303);

    return new URL(interactionUrl.replace('interaction', 'auth'), 'http://op').pathname;
  }

  // 克隆一个共享同一 OP 会话 cookie 的标签页 agent（多标签页共享 cookie 的测试替身）。
  function cloneTab(agent) {
    const tab = supertest(globalThis.server);
    tab.jar.setCookies(agent.jar.getCookies(CookieAccessInfo.All));
    return tab;
  }

  function expireCookies(...agents) {
    const expired = '_session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; httponly';
    agents.forEach((agent) => {
      agent.jar.setCookies([expired]);
    });
  }

  function readXsrf(html) {
    const match = html.match(/name="xsrf"\s+value="([^"]+)"/);
    return match ? match[1] : undefined;
  }

  it('concurrent resumes of the same user leave exactly one live session row', { timeout: 20000 }, async () => {
    const accountId = 'concurrent-resume-user';
    const readings = [];

    for (let round = 0; round < 20; round += 1) {
      TrackingSessionAdapter.reset();
      const first = supertest(globalThis.server);

      // 首次登录建立 OP 会话并完成一次恢复，得到稳定的会话行。
      const boot = await pendingResume(first, accountId);
      await first.get(boot).expect(303);

      // 两个标签页各自发起独立授权，各自产生一条待恢复交互，但共享同一 OP 会话 cookie。
      const second = cloneTab(first);
      const [resumeA, resumeB] = await Promise.all([
        pendingResume(first, accountId),
        pendingResume(second, accountId),
      ]);

      // 同秒窗口并发授权恢复（重发与首次恢复交叠）。
      const [r1, r2] = await Promise.all([
        first.get(resumeA),
        second.get(resumeB),
      ]);

      // 授权恢复必须以重定向收束，任一请求都不得以未捕获 500 收场。
      assert.equal(r1.status, 303, `round ${round}: first resume must redirect`);
      assert.equal(r2.status, 303, `round ${round}: second resume must redirect`);

      // 实测读数：该轮终态该用户标识的会话行存活行数。
      const rows = TrackingSessionAdapter.liveSessionRows(accountId);
      readings.push(rows);
      assert.equal(rows, 1, `round ${round}: exactly one live row expected, got ${rows}`);

      expireCookies(first, second);
    }

    // 20 轮终态读数全部为 1。
    assert.deepEqual(readings, Array(20).fill(1));
  });

  it('logout terminates every session row of the user identifier and isolates others', { timeout: 10000 }, async () => {
    const accountId = 'logout-user';
    const otherAccountId = 'logout-user-other';

    const target = supertest(globalThis.server);
    const targetBoot = await pendingResume(target, accountId);
    await target.get(targetBoot).expect(303);

    const other = supertest(globalThis.server);
    const otherBoot = await pendingResume(other, otherAccountId);
    await other.get(otherBoot).expect(303);

    assert.equal(TrackingSessionAdapter.liveSessionRows(accountId), 1);
    assert.equal(TrackingSessionAdapter.liveSessionRows(otherAccountId), 1);

    // 走 end_session 完整注销：init 渲染含 xsrf 的表单，confirm 带 logout=yes。
    const init = await target.get('/session/end').expect(200);
    const xsrf = readXsrf(init.text);
    assert.ok(xsrf, 'logout xsrf must be present in the rendered form');

    await target.post('/session/end/confirm')
      .send({ xsrf, logout: 'yes' })
      .type('form')
      .expect(303);

    assert.equal(
      TrackingSessionAdapter.liveSessionRows(accountId),
      0,
      'all session rows of the logged-out user identifier must be terminated',
    );
    assert.equal(
      TrackingSessionAdapter.liveSessionRows(otherAccountId),
      1,
      'session rows of other user identifiers must remain untouched',
    );
  });

  it('unique-index adapter: overlapping resume and logout never surfaces an uncaught constraint 500', { timeout: 30000 }, async () => {
    const accountId = 'unique-index-user';
    TrackingSessionAdapter.sessionAdapter().enforceUidUnique = true;

    try {
      const readings = [];

      for (let round = 0; round < 20; round += 1) {
        TrackingSessionAdapter.reset();
        // reset 会关闭约束开关，重新打开以模拟唯一索引适配器形态。
        TrackingSessionAdapter.sessionAdapter().enforceUidUnique = true;

        const first = supertest(globalThis.server);
        const boot = await pendingResume(first, accountId);
        await first.get(boot).expect(303);

        const second = cloneTab(first);
        const [resumeA, resumeB] = await Promise.all([
          pendingResume(first, accountId),
          pendingResume(second, accountId),
        ]);

        // 注销 xsrf 与并发恢复在同一窗口内取得，制造恢复与注销交叠。
        const init = await first.get('/session/end').expect(200);
        const xsrf = readXsrf(init.text);

        const outcomes = await Promise.allSettled([
          first.get(resumeA),
          second.get(resumeB),
          xsrf
            ? first.post('/session/end/confirm').send({ xsrf, logout: 'yes' }).type('form')
            : Promise.resolve(undefined),
        ]);

        for (const outcome of outcomes) {
          assert.equal(outcome.status, 'fulfilled', `round ${round}: a request threw unexpectedly`);
          if (outcome.value) {
            assert.notEqual(
              outcome.value.status,
              500,
              `round ${round}: unique constraint must not surface as an uncaught 500`,
            );
          }
        }

        const rows = TrackingSessionAdapter.liveSessionRows(accountId);
        readings.push(rows);
        assert.ok(rows <= 1, `round ${round}: at most one live row, got ${rows}`);

        expireCookies(first, second);
      }

      // 交叠收束：要么已注销（0 行），要么单行存活；绝不允许约束冲突残留多行。
      assert.ok(
        readings.every((n) => n === 0 || n === 1),
        `unexpected readings: ${readings.join(',')}`,
      );
    } finally {
      TrackingSessionAdapter.sessionAdapter().enforceUidUnique = false;
    }
  });

  it('unique-index adapter: a raw constraint conflict is contained as a retryable error, never a 500', { timeout: 10000 }, async () => {
    // HTTP 路径上的进程内 uid 锁会串行化同 uid 写入，因此唯一约束分支在正常请求中本就
    // 不应触发；它是多进程跨实例竞争的兜底。这里在模型层直接制造无锁并发 save，确定性
    // 覆盖该兜底：同 uid 两份副本各自轮换后保存，第二个 upsert 命中 23505 必须被收束为
    // SessionNotFound（可重试的 invalid_request），而不是把原始约束冲突冒泡成 500。
    TrackingSessionAdapter.reset();
    const adapter = fixture.provider.Session.adapter;
    adapter.enforceUidUnique = true;

    try {
      let constraintHits = 0;
      const originalUpsert = adapter.upsert.bind(adapter);
      adapter.upsert = async function tracked(id, payload, ttl) {
        try {
          return await originalUpsert(id, payload, ttl);
        } catch (err) {
          if (err.code === '23505') {
            constraintHits += 1;
          }
          throw err;
        }
      };

      try {
        const Session = fixture.provider.Session;
        const first = new Session({ accountId: 'constraint-containment-user' });
        await first.save(600);
        const uid = first.uid;

        const copyA = await Session.findByUid(uid);
        const copyB = await Session.findByUid(uid);
        copyA.resetIdentifier();
        copyB.resetIdentifier();

        await copyA.save(600);
        await assert.rejects(
          () => copyB.save(600),
          (err) => err.name === 'SessionNotFound',
          'unique constraint conflict must surface as a retryable SessionNotFound',
        );

        assert.ok(constraintHits >= 1, 'the unique constraint path must actually be exercised');
      } finally {
        adapter.upsert = originalUpsert;
      }
    } finally {
      adapter.enforceUidUnique = false;
    }
  });
});
