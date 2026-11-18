const test = require('node:test');
const assert = require('node:assert/strict');
const { riderCharges, driverDeductions, percentageCharge, totalDue } = require('./fees');

test('charges round each percentage line to integer pesewas', () => {
  assert.deepEqual(riderCharges(101, 12.5, 12.5), {
    stationFeePesewas: 13,
    platformFeePesewas: 13,
  });
  assert.deepEqual(driverDeductions(101, 12.5, 12.5), {
    stationDeductionPesewas: 13,
    platformDeductionPesewas: 13,
  });
});

test('zero and one-hundred percent charges stay integer pesewas', () => {
  assert.deepEqual(riderCharges(1234, 0, 100), {
    stationFeePesewas: 0,
    platformFeePesewas: 1234,
  });
  assert.deepEqual(driverDeductions(1234, 100, 0), {
    stationDeductionPesewas: 1234,
    platformDeductionPesewas: 0,
  });
});

test('tiny fares round independently and totalDue adds stored lines', () => {
  assert.deepEqual(riderCharges(1, 49, 50), {
    stationFeePesewas: 0,
    platformFeePesewas: 1,
  });
  assert.equal(totalDue({
    fare_pesewas: 1,
    station_fee_pesewas: 0,
    platform_fee_pesewas: 1,
  }), 2);
});

test('loading fees are included in totals and round to pesewas', () => {
  assert.equal(percentageCharge(101, 12.5), 13);
  assert.equal(totalDue({
    fare_pesewas: 1000,
    station_fee_pesewas: 50,
    platform_fee_pesewas: 25,
    loading_fee_pesewas: 75,
  }), 1150);
});
