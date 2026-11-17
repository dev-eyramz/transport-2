const DEFAULT_MOMO_PARTNERS = 'MTNGH,ATGH,TCELGH';

function readEnv(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === null || value === '' ? fallback : value;
}

function parsePartnerList(value) {
  return String(value || DEFAULT_MOMO_PARTNERS)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.toUpperCase());
}

function normalizeMsisdn(value) {
  if (value === undefined || value === null) return '';
  let input = String(value).trim().replace(/[\s-]/g, '');
  if (!input) return '';
  if (input.startsWith('+')) input = input.slice(1);
  if (input.startsWith('00')) input = input.slice(2);
  if (input.startsWith('233')) return input;
  if (input.startsWith('0')) return `233${input.slice(1)}`;
  return `233${input}`;
}

function isMomoPayPartner(paypartnerCode) {
  if (!paypartnerCode) return false;
  const partner = String(paypartnerCode).trim().toUpperCase();
  return parsePartnerList(readEnv('EGANOW_MOMO_PARTNERS', DEFAULT_MOMO_PARTNERS)).includes(partner);
}

class EganowPaymentProvider {
  constructor(envPrefix = 'EGANOW') {
    this.name = 'eganow';
    this.envPrefix = envPrefix;
  }

  env(name, fallback) {
    return readEnv(`${this.envPrefix}_${name}`, fallback);
  }

  getBaseUrl() {
    const value = this.env('BASE_URL', '').trim();
    if (!value) throw new Error(`${this.envPrefix}_BASE_URL must be configured`);
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error(`${this.envPrefix}_BASE_URL must use HTTPS`);
    return url.toString().replace(/\/+$/, '');
  }

  getApiUsername() {
    return this.env('API_USERNAME', '');
  }

  getApiPassword() {
    return this.env('API_PASSWORD', '');
  }

  getXAuth() {
    return this.env('X_AUTH', '');
  }

  getDefaultCountryCode() {
    return this.env('DEFAULT_COUNTRY_CODE', 'GH0233');
  }

  getDefaultLanguage() {
    return this.env('DEFAULT_LANGUAGE', 'en');
  }

  getCallbackUrl() {
    return this.env('CALLBACK_URL', '');
  }

  getSupportedPayPartners() {
    return parsePartnerList(this.env('MOMO_PARTNERS', DEFAULT_MOMO_PARTNERS));
  }

  buildAuthHeaders(token, extraHeaders = {}) {
    return {
      ...extraHeaders,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-Auth': this.getXAuth(),
    };
  }

  async request(path, options = {}) {
    const { method = 'GET', token, body, headers = {} } = options;
    const url = new URL(path, `${this.getBaseUrl().replace(/\/$/, '')}/`);
    const requestHeaders = { ...headers };
    if (token) {
      Object.assign(requestHeaders, this.buildAuthHeaders(token, headers));
    }

    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    if (payload && !requestHeaders['Content-Type']) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: payload,
      signal: AbortSignal.timeout(20000),
    });

    const text = await response.text();
    let parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const detail = typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed).slice(0, 300) : text.slice(0, 300);
      throw new Error(`Eganow API error (${response.status}): ${detail || 'request failed'}`);
    }

    return parsed;
  }

  async getAccessToken() {
    const username = this.getApiUsername();
    const password = this.getApiPassword();
    if (!username || !password) {
      throw new Error(`Missing ${this.envPrefix}_API_USERNAME or ${this.envPrefix}_API_PASSWORD`);
    }

    const response = await fetch(`${this.getBaseUrl().replace(/\/$/, '')}/api/auth/token`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(20000),
    });

    const text = await response.text();
    let payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`Token request failed (${response.status}): ${text}`);
    }

    const bearerToken = payload.developerJwtToken || payload.accessToken || payload.token;
    if (!bearerToken) {
      throw new Error('Eganow token response did not include a bearer token');
    }

    return { ...payload, bearerToken };
  }

  async verifyAccessToken(token = null) {
    const resolvedToken = token || (await this.getAccessToken()).bearerToken;
    return this.request('/api/auth/verify', { method: 'POST', token: resolvedToken });
  }

  async searchPartners({ countryCode = this.getDefaultCountryCode(), languageId = this.getDefaultLanguage() } = {}) {
    const token = (await this.getAccessToken()).bearerToken;
    return this.request('/api/partners/search', {
      method: 'POST',
      token,
      body: { countryCode, languageId },
    });
  }

  async initiateCollection(payload = {}) {
    const normalizedPayload = { ...payload };
    const paypartnerCode = String(normalizedPayload.paypartnerCode || '').trim().toUpperCase();
    if (!paypartnerCode) {
      throw new Error('A paypartnerCode is required');
    }
    if (!this.getSupportedPayPartners().includes(paypartnerCode)) {
      throw new Error(`Unsupported payment partner for Eganow MoMo integration: ${paypartnerCode}`);
    }

    if (!normalizedPayload.languageId) normalizedPayload.languageId = this.getDefaultLanguage();
    if (!normalizedPayload.transCurrencyIso) normalizedPayload.transCurrencyIso = 'GHS';
    if (!normalizedPayload.callback) normalizedPayload.callback = this.getCallbackUrl();
    if (!normalizedPayload.countryCode) normalizedPayload.countryCode = this.getDefaultCountryCode();
    if (normalizedPayload.accountNoOrCardNoOrMSISDN) {
      normalizedPayload.accountNoOrCardNoOrMSISDN = normalizeMsisdn(normalizedPayload.accountNoOrCardNoOrMSISDN);
    }
    if (!normalizedPayload.transactionId && normalizedPayload.reference) {
      normalizedPayload.transactionId = normalizedPayload.reference;
    }

    const token = (await this.getAccessToken()).bearerToken;
    return this.request('/api/transactions/collection', {
      method: 'POST',
      token,
      body: normalizedPayload,
    });
  }

  async initiatePayout(payload = {}) {
    const normalizedPayload = { ...payload };
    const paypartnerCode = String(normalizedPayload.paypartnerCode || '').trim().toUpperCase();
    if (!paypartnerCode) {
      throw new Error('A paypartnerCode is required');
    }
    if (!this.getSupportedPayPartners().includes(paypartnerCode)) {
      throw new Error(`Unsupported payment partner for Eganow MoMo integration: ${paypartnerCode}`);
    }

    if (!normalizedPayload.languageId) normalizedPayload.languageId = this.getDefaultLanguage();
    if (!normalizedPayload.transCurrencyIso) normalizedPayload.transCurrencyIso = 'GHS';
    if (!normalizedPayload.callback) normalizedPayload.callback = this.getCallbackUrl();
    if (!normalizedPayload.countryCode) normalizedPayload.countryCode = this.getDefaultCountryCode();
    if (normalizedPayload.accountNoOrCardNoOrMSISDN) {
      normalizedPayload.accountNoOrCardNoOrMSISDN = normalizeMsisdn(normalizedPayload.accountNoOrCardNoOrMSISDN);
    }
    if (!normalizedPayload.transactionId && normalizedPayload.reference) {
      normalizedPayload.transactionId = normalizedPayload.reference;
    }

    const token = (await this.getAccessToken()).bearerToken;
    return this.request('/api/transactions/payout', {
      method: 'POST',
      token,
      body: normalizedPayload,
    });
  }

  async getCollectionBalance() {
    const token = (await this.getAccessToken()).bearerToken;
    return this.request('/api/transactions/collection/get-balance', { method: 'GET', token });
  }

  async getPayoutBalance() {
    const token = (await this.getAccessToken()).bearerToken;
    return this.request('/api/transactions/payout/get-balance', { method: 'GET', token });
  }

  async getTransactionStatus({ transactionId, languageId = this.getDefaultLanguage() } = {}) {
    if (!transactionId) {
      throw new Error('transactionId is required');
    }
    const token = (await this.getAccessToken()).bearerToken;
    return this.request('/api/transactions/status', {
      method: 'POST',
      token,
      body: { transactionId, languageId },
    });
  }

  async verifyKyc(payload = {}) {
    const normalizedPayload = { ...payload };
    normalizedPayload.countryCode = normalizedPayload.countryCode || this.getDefaultCountryCode();
    normalizedPayload.languageId = normalizedPayload.languageId || this.getDefaultLanguage();
    normalizedPayload.paypartnerCode = String(normalizedPayload.paypartnerCode || '').trim().toUpperCase();
    if (!normalizedPayload.paypartnerCode) {
      throw new Error('A paypartnerCode is required');
    }
    if (!this.getSupportedPayPartners().includes(normalizedPayload.paypartnerCode)) {
      throw new Error(`Unsupported payment partner for Eganow MoMo integration: ${normalizedPayload.paypartnerCode}`);
    }
    if (normalizedPayload.accountNoOrCardNoOrMSISDN) {
      normalizedPayload.accountNoOrCardNoOrMSISDN = normalizeMsisdn(normalizedPayload.accountNoOrCardNoOrMSISDN);
    }

    const token = (await this.getAccessToken()).bearerToken;
    return this.request('/api/vas/kyc', {
      method: 'POST',
      token,
      body: normalizedPayload,
    });
  }
}

function createPaymentProvider(name = process.env.PAYMENT_PROVIDER || 'eganow', { envPrefix = 'EGANOW' } = {}) {
  if (name === 'mock' && process.env.NODE_ENV !== 'test') {
    throw new Error('PAYMENT_PROVIDER=mock is only allowed in tests');
  }

  const providers = {
    eganow: () => new EganowPaymentProvider(envPrefix),
    mock: () => ({
      name: 'mock',
      getSupportedPayPartners: () => parsePartnerList(readEnv(`${envPrefix}_MOMO_PARTNERS`, DEFAULT_MOMO_PARTNERS)),
      getAccessToken: async () => ({ bearerToken: 'mock-token' }),
      verifyAccessToken: async () => ({ isValid: true }),
      initiateCollection: async (payload) => ({ ok: true, payload, provider: 'mock' }),
      initiatePayout: async (payload) => ({ ok: true, payload, provider: 'mock' }),
      getTransactionStatus: async () => ({ isSuccess: true, transactionstatus: 'SUCCESSFUL' }),
      verifyKyc: async () => ({ isSuccess: true, accountName: 'MOCK ACCOUNT' }),
      getCollectionBalance: async () => ({ balance: 0 }),
      getPayoutBalance: async () => ({ balance: 0 }),
    }),
  };

  if (!providers[name]) {
    throw new Error(`Unsupported payment provider: ${name}`);
  }

  return providers[name]();
}

function isSupportedPayPartner(provider, paypartnerCode) {
  const partnerCodes = Array.isArray(provider?.getSupportedPayPartners?.())
    ? provider.getSupportedPayPartners()
    : parsePartnerList(readEnv('EGANOW_MOMO_PARTNERS', DEFAULT_MOMO_PARTNERS));
  return partnerCodes.includes(String(paypartnerCode || '').trim().toUpperCase());
}

module.exports = {
  DEFAULT_MOMO_PARTNERS,
  EganowPaymentProvider,
  normalizeMsisdn,
  isSupportedPayPartner,
  createPaymentProvider,
  isMomoPayPartner,
};
