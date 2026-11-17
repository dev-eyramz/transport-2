function percentCharge(farePesewas, percentage) {
  return Math.round(Number(farePesewas) * Number(percentage) / 100);
}

function riderCharges(farePesewas, stationPct, platformPct) {
  return {
    stationFeePesewas: percentCharge(farePesewas, stationPct),
    platformFeePesewas: percentCharge(farePesewas, platformPct),
  };
}

function driverDeductions(farePesewas, stationPct, platformPct) {
  return {
    stationDeductionPesewas: percentCharge(farePesewas, stationPct),
    platformDeductionPesewas: percentCharge(farePesewas, platformPct),
  };
}

function totalDue(booking) {
  return Number(booking.fare_pesewas || 0)
    + Number(booking.station_fee_pesewas || 0)
    + Number(booking.platform_fee_pesewas || 0);
}

module.exports = { riderCharges, driverDeductions, totalDue };
