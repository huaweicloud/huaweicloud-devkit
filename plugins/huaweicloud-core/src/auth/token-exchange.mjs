import { fetchWithProxy } from '../proxy/proxy-agent.mjs';

const DEFAULT_DURATION_SECONDS = 900;
const DEFAULT_IAM_ENDPOINT = 'https://iam.myhuaweicloud.com';

export async function exchangeTokenForCredentials(token, options = {}) {
  const durationSeconds = options.durationSeconds ?? DEFAULT_DURATION_SECONDS;
  const iamEndpoint = options.iamEndpoint || process.env.HW_TOKEN_IAM_ENDPOINT || DEFAULT_IAM_ENDPOINT;
  const fetchImpl = options.fetchImpl;

  const body = {
    auth: {
      identity: {
        methods: ['token'],
        token: { id: token, duration_seconds: durationSeconds },
      },
    },
  };

  const fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf8' },
    body: JSON.stringify(body),
  };

  const url = `${iamEndpoint}/v3.0/OS-CREDENTIAL/securitytokens`;

  let resp;
  try {
    resp = fetchImpl ? await fetchImpl(url, fetchOpts) : await fetchWithProxy(url, fetchOpts);
  } catch (error) {
    const err = new Error(`Token exchange request failed: ${error.message}`);
    err.code = 'TOKEN_EXCHANGE_FAILED';
    throw err;
  }

  if (resp.status === 401 || resp.status === 403) {
    const err = new Error('X-Auth-Token is invalid or expired.');
    err.code = 'TOKEN_INVALID';
    throw err;
  }
  if (resp.status !== 201) {
    const err = new Error(`Token exchange returned unexpected status ${resp.status}.`);
    err.code = 'TOKEN_EXCHANGE_FAILED';
    throw err;
  }

  let data;
  try {
    data = await resp.json();
  } catch (error) {
    const err = new Error(`Token exchange returned malformed JSON: ${error.message}`);
    err.code = 'TOKEN_EXCHANGE_FAILED';
    throw err;
  }
  const cred = data?.credential;
  if (!cred?.access || !cred?.secret || !cred?.securitytoken) {
    const err = new Error('Token exchange response missing credential fields.');
    err.code = 'TOKEN_EXCHANGE_FAILED';
    throw err;
  }
  const expiresAt = cred.expires_at ? Date.parse(cred.expires_at) : NaN;
  return {
    ak: cred.access,
    sk: cred.secret,
    securityToken: cred.securitytoken,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
  };
}
