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

test('mock payment provider is restricted to tests', () => {
  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.throws(() => createPaymentProvider('mock'), /only allowed in tests/);
    process.env.NODE_ENV = 'test';
    assert.equal(createPaymentProvider('mock').name, 'mock');
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
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

test('Eganow provider requires an explicit HTTPS endpoint', () => {
  const endpoint = process.env.EGANOW_BASE_URL;
  delete process.env.EGANOW_BASE_URL;
  assert.throws(() => createPaymentProvider().getBaseUrl(), /EGANOW_BASE_URL must be configured/);
  process.env.EGANOW_BASE_URL = 'http://insecure.example';
  assert.throws(() => createPaymentProvider().getBaseUrl(), /EGANOW_BASE_URL must use HTTPS/);
  process.env.EGANOW_BASE_URL = endpoint;
});
