const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PAYMENT_PROVIDER = 'eganow';
process.env.EGANOW_BASE_URL = 'https://developer.sandbox.egacoreapi.com';
process.env.EGANOW_API_USERNAME = 'merchant-user';
process.env.EGANOW_API_PASSWORD = 'merchant-pass';
process.env.EGANOW_X_AUTH = 'x-auth-secret';
process.env.EGANOW_DEFAULT_COUNTRY_CODE = 'GH0233';
process.env.EGANOW_DEFAULT_LANGUAGE = 'en';
process.env.EGANOW_MOMO_PARTNERS = 'MTNGH,ATGH,TCELGH';

const { createPaymentProvider, normalizeMsisdn, isSupportedPayPartner } = require('./payment');

test('normalizeMsisdn converts local Ghana numbers to international format', () => {
  assert.equal(normalizeMsisdn('0244123456'), '233244123456');
  assert.equal(normalizeMsisdn('233244123456'), '233244123456');
  assert.equal(normalizeMsisdn('+233244123456'), '233244123456');
});

test('provider validates supported MoMo partners only', () => {
  const provider = createPaymentProvider();
  assert.equal(isSupportedPayPartner(provider, 'MTNGH'), true);
  assert.equal(isSupportedPayPartner(provider, 'ATGH'), true);
  assert.equal(isSupportedPayPartner(provider, 'TCELGH'), true);
  assert.equal(isSupportedPayPartner(provider, 'UNSUPPORTED'), false);
});

test('tenant provider credentials do not inherit platform environment credentials', () => {
  const provider = createPaymentProvider('eganow', { config: {} });
  assert.equal(provider.getApiUsername(), '');
  assert.equal(provider.getApiPassword(), '');
  assert.throws(() => createPaymentProvider('mock'), /Unsupported payment provider/);
});

test('fee provider reads credentials and partner configuration from its own prefix', () => {
  process.env.FEES_EGANOW_BASE_URL = 'https://fees.example';
  process.env.FEES_EGANOW_MOMO_PARTNERS = 'ATGH';
  const provider = createPaymentProvider('eganow', { envPrefix: 'FEES_EGANOW' });
  assert.equal(provider.getBaseUrl(), 'https://fees.example');
  assert.equal(isSupportedPayPartner(provider, 'ATGH'), true);
  assert.equal(isSupportedPayPartner(provider, 'MTNGH'), false);
  delete process.env.FEES_EGANOW_BASE_URL;
  delete process.env.FEES_EGANOW_MOMO_PARTNERS;
});

test('provider builds auth headers and endpoints from config', async () => {
  const provider = createPaymentProvider();
  assert.equal(provider.getBaseUrl(), 'https://developer.sandbox.egacoreapi.com');
  assert.equal(typeof provider.getAccessToken, 'function');
  const headers = provider.buildAuthHeaders('demo-token');
  assert.equal(headers.Authorization, 'Bearer demo-token');
  assert.equal(headers['x-Auth'], 'x-auth-secret');
});

test('collection initiation authenticates and normalizes its payment payload', async () => {
  const provider = createPaymentProvider();
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    const body = requests.length === 1
      ? { developerJwtToken: 'collection-token' }
      : { transactionstatus: 'PENDING' };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const result = await provider.initiateCollection({
      amount: '12.50',
      transactionId: 'TP-123',
      paypartnerCode: 'mtngh',
      accountNoOrCardNoOrMSISDN: '0244 123 456',
    });
    assert.equal(result.transactionstatus, 'PENDING');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://developer.sandbox.egacoreapi.com/api/auth/token');
    assert.equal(requests[0].options.headers.Authorization, `Basic ${Buffer.from('merchant-user:merchant-pass').toString('base64')}`);
    assert.equal(requests[1].url, 'https://developer.sandbox.egacoreapi.com/api/transactions/collection');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer collection-token');
    assert.equal(requests[1].options.headers['x-Auth'], 'x-auth-secret');
    assert.deepEqual(JSON.parse(requests[1].options.body), {
      amount: '12.50',
      transactionId: 'TP-123',
      paypartnerCode: 'MTNGH',
      accountNoOrCardNoOrMSISDN: '233244123456',
      languageId: 'en',
      transCurrencyIso: 'GHS',
      callback: '',
      countryCode: 'GH0233',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('payout and transaction-status requests use the configured Eganow endpoints', async () => {
  const provider = createPaymentProvider();
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    const body = requests.length === 1
      ? { accessToken: 'payout-token' }
      : requests.length === 2
        ? { transactionstatus: 'PENDING' }
        : requests.length === 3
          ? { accessToken: 'status-token' }
          : { transactionstatus: 'SUCCESSFUL' };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    await provider.initiatePayout({
      amount: '10.25',
      transactionId: 'TPPO-123',
      paypartnerCode: 'atgh',
      accountNoOrCardNoOrMSISDN: '+233 244 123 456',
    });
    const status = await provider.getTransactionStatus({ transactionId: 'TPPO-123' });
    assert.equal(status.transactionstatus, 'SUCCESSFUL');
    assert.equal(requests[1].url, 'https://developer.sandbox.egacoreapi.com/api/transactions/payout');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer payout-token');
    assert.deepEqual(JSON.parse(requests[1].options.body), {
      amount: '10.25',
      transactionId: 'TPPO-123',
      paypartnerCode: 'ATGH',
      accountNoOrCardNoOrMSISDN: '233244123456',
      languageId: 'en',
      transCurrencyIso: 'GHS',
      callback: '',
      countryCode: 'GH0233',
    });
    assert.equal(requests[3].url, 'https://developer.sandbox.egacoreapi.com/api/transactions/status');
    assert.equal(requests[3].options.headers.Authorization, 'Bearer status-token');
    assert.deepEqual(JSON.parse(requests[3].options.body), {
      transactionId: 'TPPO-123',
      languageId: 'en',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('Eganow provider requires an explicit HTTPS endpoint', () => {
  const endpoint = process.env.EGANOW_BASE_URL;
  delete process.env.EGANOW_BASE_URL;
  assert.throws(() => createPaymentProvider().getBaseUrl(), /EGANOW_BASE_URL must be configured/);
  process.env.EGANOW_BASE_URL = 'http://insecure.example';
  assert.throws(() => createPaymentProvider().getBaseUrl(), /EGANOW_BASE_URL must use HTTPS/);
  process.env.EGANOW_BASE_URL = endpoint;
});
