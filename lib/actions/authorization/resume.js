import camelCase from '../../helpers/_/camel_case.js';
import upperFirst from '../../helpers/_/upper_first.js';
import epochTime from '../../helpers/epoch_time.js';
import * as errors from '../../helpers/errors.js';
import nanoid from '../../helpers/nanoid.js';
import Params from '../../helpers/params.js';
import instance from '../../helpers/weak_cache.js';
import formPost from '../../response_modes/form_post.js';
import { getAuthorizationParams } from './request_parameters.js';

const errorMap = { ...errors };

export default async function resumeAction(ctx, next) {
  const resumeRouteName = ctx.oidc.route === 'device_resume' ? 'device_resume' : 'resume';
  const cookieOptions = instance(ctx.oidc.provider).configuration.cookies.short;

  const cookieId = ctx.cookies.get(
    ctx.oidc.provider.cookieName('resume'),
    cookieOptions,
  );

  if (!cookieId) {
    throw new errors.SessionNotFound('authorization request has expired');
  }

  const interactionSession = await ctx.oidc.provider.Interaction.find(cookieId);
  if (!interactionSession) {
    throw new errors.SessionNotFound('interaction session not found');
  }
  ctx.oidc.entity('Interaction', interactionSession);

  if (cookieId !== interactionSession.uid) {
    throw new errors.SessionNotFound('authorization session and cookie identifier mismatch');
  }

  const {
    result,
    params: storedParams = {},
    trusted = [],
    session: originSession,
  } = interactionSession;

  let { session } = ctx.oidc;

  if (originSession?.uid && originSession.uid !== session.uid) {
    // 用是否带 exp 区分两种 uid 不匹配：
    //   - 当前是空会话（无 exp）：cookie 的 jti 已失效，精确对应并发授权恢复——同一 uid
    //     的前一个恢复请求已轮换并销毁旧 jti，Session.get 回读不到只给了空会话。此时按
    //     交互记录的稳定 uid 回读权威会话并重新挂接；
    //   - 当前是另一个已持久化会话（有 exp，例如用户在交互期间重新登录）：属于“交互来
    //     源会话已被替换”的安全场景，必须维持既有不匹配错误，不能被挂接绕过。
    if (typeof session.exp !== 'number') {
      const reattached = await ctx.oidc.provider.Session.reattachByUid(ctx, originSession.uid);
      if (reattached) {
        // attachSession 重建了会话 Proxy，重新读取以绑定权威会话对象。
        session = ctx.oidc.session;
      } else {
        throw new errors.SessionNotFound('interaction session and authentication session mismatch');
      }
    } else {
      throw new errors.SessionNotFound('interaction session and authentication session mismatch');
    }
  }

  if (
    result?.login
    && session.accountId
    && session.accountId !== result.login.accountId
  ) {
    if (interactionSession.session?.uid) {
      delete interactionSession.session.uid;
      await interactionSession.save(interactionSession.exp - epochTime());
    }

    session.state = {
      secret: nanoid(),
      clientId: storedParams.client_id,
      postLogoutRedirectUri: ctx.oidc.urlFor(ctx.oidc.route, ctx.params),
    };

    formPost(ctx, ctx.oidc.urlFor('end_session_confirm'), {
      xsrf: session.state.secret,
      logout: 'yes',
    });

    return;
  }

  await interactionSession.destroy();

  const params = new Params(getAuthorizationParams(ctx), storedParams);
  ctx.oidc.params = params;
  ctx.oidc.trusted = trusted;
  ctx.oidc.redirectUriCheckPerformed = true;

  const clearOpts = {
    ...cookieOptions,
    path: new URL(ctx.oidc.urlFor(resumeRouteName, { uid: interactionSession.uid })).pathname,
  };
  ctx.cookies.set(
    ctx.oidc.provider.cookieName('resume'),
    null,
    clearOpts,
  );

  if (result?.error) {
    const className = upperFirst(camelCase(result.error));
    if (errorMap[className]) {
      throw new errorMap[className](result.error_description);
    }
    throw new errors.CustomOIDCProviderError(result.error, result.error_description);
  }

  if (result?.login) {
    const {
      remember = true, accountId, ts: loginTs, amr, acr,
    } = result.login;

    session.loginAccount({
      accountId, loginTs, amr, acr, transient: !remember,
    });
  }

  ctx.oidc.result = result;

  if (!session.new) {
    session.resetIdentifier();
  }

  await next();
}
