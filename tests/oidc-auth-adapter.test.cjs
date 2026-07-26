const assert = require("node:assert/strict");
const test = require("node:test");

const {
  LOGIN_COOKIE,
  OidcAuthAdapter,
  SESSION_COOKIE,
  createOidcAuthAdapter,
  digest,
  openLoginTransaction,
  readCookie,
} = require("../server/auth/oidc-auth-adapter.cjs");

const SESSION_SECRET = "test-only-session-secret-that-is-long-enough-for-aes";

function oidcConfig(overrides = {}) {
  return {
    issuerUrl: "https://issuer.example.test/",
    clientId: "client_test",
    clientSecret: "test-only-client-secret",
    redirectUri: "https://app.example.test/auth/callback",
    publicBaseUrl: "https://app.example.test/",
    sessionSecret: SESSION_SECRET,
    sessionAbsoluteTtlMs: 8 * 60 * 60 * 1000,
    sessionIdleTtlMs: 30 * 60 * 1000,
    ...overrides,
  };
}

function deterministicRandomBytes() {
  let counter = 1;
  return (length) => {
    const bytes = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (counter + index) % 256;
    }
    counter = (counter + length + 17) % 256;
    return bytes;
  };
}

function cookieValue(setCookie, name) {
  return readCookie(setCookie.split(";")[0], name);
}

function fakePersistence() {
  const calls = [];
  let sessionRecord = null;
  return {
    calls,
    get sessionRecord() {
      return sessionRecord;
    },
    async createUserFromIdentity(record) {
      calls.push({ method: "createUserFromIdentity", record });
      return { id: "usr_test" };
    },
    async createSession(record) {
      sessionRecord = record;
      calls.push({ method: "createSession", record });
      return {
        id: record.id,
        userId: record.userId,
        expiresAt: record.expiresAt,
        idleExpiresAt: record.idleExpiresAt,
      };
    },
    async resolveSession(record) {
      calls.push({ method: "resolveSession", record });
      if (!sessionRecord || record.tokenHash !== sessionRecord.tokenHash) return null;
      return {
        id: sessionRecord.id,
        userId: sessionRecord.userId,
        csrfTokenHash: sessionRecord.csrfTokenHash,
        expiresAt: sessionRecord.expiresAt,
        idleExpiresAt: sessionRecord.idleExpiresAt,
      };
    },
    async revokeSession(record) {
      calls.push({ method: "revokeSession", record });
      return true;
    },
  };
}

function fakeClient() {
  const calls = [];
  return {
    calls,
    authorizationUrl(parameters) {
      calls.push({ method: "authorizationUrl", parameters });
      return `https://issuer.example.test/authorize?state=${parameters.state}`;
    },
    async callback(redirectUri, params, checks) {
      calls.push({ method: "callback", redirectUri, params, checks });
      return {
        access_token: "must-never-be-persisted",
        refresh_token: "must-never-be-persisted",
        id_token: "must-never-be-persisted",
        claims() {
          return {
            iss: "https://issuer.example.test/",
            sub: "provider-subject-123",
          };
        },
      };
    },
  };
}

test("OIDC discovery is explicit and importing the adapter performs no network work", async () => {
  let discoveries = 0;
  let clientConfiguration;
  class Client {
    constructor(configuration) {
      clientConfiguration = configuration;
    }
  }
  const adapter = await createOidcAuthAdapter({
    config: oidcConfig(),
    persistence: fakePersistence(),
    oidc: {
      Issuer: {
        async discover(url) {
          discoveries += 1;
          assert.equal(url, "https://issuer.example.test/");
          return { Client };
        },
      },
    },
  });
  assert.equal(discoveries, 1);
  assert.equal(clientConfiguration.client_id, "client_test");
  assert.equal(clientConfiguration.response_types[0], "code");
  assert.equal((await adapter.health()).ready, true);
});

test("OIDC login uses PKCE, nonce and an authenticated encrypted ten-minute cookie", async () => {
  const client = fakeClient();
  const adapter = new OidcAuthAdapter({
    config: oidcConfig(),
    persistence: fakePersistence(),
    client,
    clock: { now: () => 1_000_000 },
    randomBytes: deterministicRandomBytes(),
  });
  const login = await adapter.beginLogin({ returnTo: "/projects/prj_test" });
  const parameters = client.calls[0].parameters;
  assert.equal(parameters.response_type, "code");
  assert.equal(parameters.code_challenge_method, "S256");
  assert.equal(parameters.code_challenge.length >= 43, true);
  assert.equal(parameters.state.length >= 43, true);
  assert.equal(parameters.nonce.length >= 43, true);
  assert.match(login.setCookie, /^__Host-shortsen_login=/);
  assert.match(login.setCookie, /Max-Age=600/);
  assert.match(login.setCookie, /Secure; HttpOnly; SameSite=Lax/);

  const encrypted = cookieValue(login.setCookie, LOGIN_COOKIE);
  assert.doesNotMatch(encrypted, new RegExp(parameters.state));
  const transaction = openLoginTransaction(encrypted, SESSION_SECRET);
  assert.equal(transaction.state, parameters.state);
  assert.equal(transaction.nonce, parameters.nonce);
  assert.equal(transaction.returnTo, "/projects/prj_test");
  assert.equal(transaction.expiresAt, 1_600_000);
});

test("OIDC callback persists only session hashes and never provider tokens", async () => {
  const persistence = fakePersistence();
  const client = fakeClient();
  const adapter = new OidcAuthAdapter({
    config: oidcConfig(),
    persistence,
    client,
    clock: { now: () => 2_000_000 },
    randomBytes: deterministicRandomBytes(),
  });
  const login = await adapter.beginLogin({ returnTo: "//attacker.example/" });
  const encrypted = cookieValue(login.setCookie, LOGIN_COOKIE);
  const transaction = openLoginTransaction(encrypted, SESSION_SECRET);
  const completed = await adapter.completeLogin({
    params: { code: "authorization-code", state: transaction.state },
    transactionCookie: encrypted,
  });

  assert.equal(completed.principal.id, "usr_test");
  assert.equal(completed.principal.authMode, "oidc");
  assert.equal(completed.returnTo, "/");
  assert.equal(completed.setCookies.length, 2);
  assert.match(completed.setCookies[0], new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(completed.setCookies[0], /Secure; HttpOnly; SameSite=Lax/);
  assert.match(completed.setCookies[1], /Max-Age=0/);

  const sessionToken = cookieValue(completed.setCookies[0], SESSION_COOKIE);
  assert.equal(persistence.sessionRecord.tokenHash, digest(sessionToken));
  assert.equal(persistence.sessionRecord.csrfTokenHash, digest(completed.csrfToken));
  assert.equal(persistence.sessionRecord.expiresAt, new Date(30_800_000).toISOString());
  assert.equal(persistence.sessionRecord.idleExpiresAt, new Date(3_800_000).toISOString());

  const persisted = JSON.stringify(persistence.calls);
  assert.doesNotMatch(persisted, /must-never-be-persisted/);
  assert.doesNotMatch(persisted, new RegExp(sessionToken));
  assert.doesNotMatch(persisted, new RegExp(completed.csrfToken));
  assert.deepEqual(persistence.calls[0], {
    method: "createUserFromIdentity",
    record: {
      issuer: "https://issuer.example.test/",
      subject: "provider-subject-123",
    },
  });

  const callbackCall = client.calls.find((call) => call.method === "callback");
  assert.equal(callbackCall.checks.code_verifier, transaction.verifier);
  assert.equal(callbackCall.checks.state, transaction.state);
  assert.equal(callbackCall.checks.nonce, transaction.nonce);
});

test("OIDC login transaction rejects stale state and tampering", async () => {
  let now = 10_000;
  const adapter = new OidcAuthAdapter({
    config: oidcConfig(),
    persistence: fakePersistence(),
    client: fakeClient(),
    clock: { now: () => now },
    randomBytes: deterministicRandomBytes(),
  });
  const login = await adapter.beginLogin();
  const encrypted = cookieValue(login.setCookie, LOGIN_COOKIE);
  const transaction = openLoginTransaction(encrypted, SESSION_SECRET);
  await assert.rejects(
    adapter.completeLogin({
      params: { code: "code", state: "wrong-state" },
      transactionCookie: encrypted,
    }),
    (error) => error.code === "OIDC_AUTH_FAILED" && error.status === 401,
  );

  await assert.rejects(
    adapter.completeLogin({
      params: { code: "code", state: transaction.state },
      transactionCookie: `${encrypted.slice(0, -1)}A`,
    }),
    (error) => error.code === "OIDC_AUTH_FAILED",
  );

  now += 10 * 60 * 1000 + 1;
  await assert.rejects(
    adapter.completeLogin({
      params: { code: "code", state: transaction.state },
      transactionCookie: encrypted,
    }),
    (error) => error.code === "OIDC_AUTH_FAILED",
  );
});

test("session resolution, CSRF origin binding and logout use only hashed tokens", async () => {
  const persistence = fakePersistence();
  const client = fakeClient();
  const adapter = new OidcAuthAdapter({
    config: oidcConfig(),
    persistence,
    client,
    clock: { now: () => 5_000_000 },
    randomBytes: deterministicRandomBytes(),
  });
  const login = await adapter.beginLogin();
  const encrypted = cookieValue(login.setCookie, LOGIN_COOKIE);
  const transaction = openLoginTransaction(encrypted, SESSION_SECRET);
  const completed = await adapter.completeLogin({
    params: { code: "code", state: transaction.state },
    transactionCookie: encrypted,
  });
  const sessionToken = cookieValue(completed.setCookies[0], SESSION_COOKIE);
  const session = await adapter.resolveSession({ sessionToken });
  assert.equal(session.principal.id, "usr_test");
  assert.equal(session.principal.canAccessUnowned, false);
  assert.equal(persistence.calls.at(-1).record.tokenHash, digest(sessionToken));
  assert.equal(persistence.calls.at(-1).record.idleTtlMs, 30 * 60 * 1000);

  assert.equal(adapter.assertCsrf({
    method: "POST",
    origin: "https://app.example.test",
    csrfToken: completed.csrfToken,
    session,
  }), true);
  assert.equal(adapter.assertCsrf({
    method: "GET",
    origin: "",
    csrfToken: "",
    session: null,
  }), true);
  assert.throws(
    () => adapter.assertCsrf({
      method: "POST",
      origin: "https://attacker.example.test",
      csrfToken: completed.csrfToken,
      session,
    }),
    (error) => error.code === "CSRF_INVALID" && error.status === 403,
  );
  assert.throws(
    () => adapter.assertCsrf({
      method: "POST",
      origin: "https://app.example.test",
      csrfToken: "wrong-token",
      session,
    }),
    (error) => error.code === "CSRF_INVALID",
  );

  const loggedOut = await adapter.logout({
    sessionToken,
    userId: "usr_test",
  });
  assert.match(loggedOut.setCookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(loggedOut.setCookie, /Max-Age=0/);
  assert.equal(persistence.calls.at(-1).record.tokenHash, digest(sessionToken));
  assert.doesNotMatch(JSON.stringify(persistence.calls.at(-1)), new RegExp(sessionToken));
});
