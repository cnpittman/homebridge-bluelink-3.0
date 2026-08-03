import { HyundaiService } from './base';
import { VehicleStatus } from 'bluelinky/dist/interfaces/common.interfaces';

export class Motor extends HyundaiService {
  private maxRange?: number;
  private currentRange?: number;
  private batteryChargeHV?: number;
  private chargingState: number = 2; //default to NOT_CHARGEABLE
  private charging = false;
  name = 'Motor';
  serviceType = 'Battery';
  lowBatteryThreshold = 25;

  initService(): void {
    this.maxRange = this.accessory.context.device.maxRange;

    const { BatteryLevel, ChargingState, StatusLowBattery } =
      this.Characteristic;
    this.service
      ?.getCharacteristic(BatteryLevel)
      .on('get', cb => cb(null, this.rangePct));
    this.service
      ?.getCharacteristic(ChargingState)
      .on('get', cb => cb(null, this.chargingState));
    this.service
      ?.getCharacteristic(StatusLowBattery)
      .on('get', cb => cb(null, this.statusLowBattery));
  }
  setCurrentState(status: VehicleStatus): void {
    // Normalise before comparing. Vehicles that never report charging send
    // undefined, which never equals the stored false, so this logged a
    // "change" on every single poll.
    const charging = status.engine.charging ?? false;
    if (charging !== this.charging) {
      this.charging = charging;
      this.log.info(`new charging state ${this.charging}`);
      this.chargingState = this.charging ? 1 : 0;
    }
    if (status.engine.range !== this.currentRange) {
      this.currentRange = status.engine.range;
      this.log.info(`new range ${this.currentRange}`);
    }
    if (!this.maxRange || this.currentRange > this.maxRange) {
      this.maxRange = this.currentRange;
      this.log.info(`maxRange is ${this.maxRange}`);
    }
    if (this.batteryChargeHV !== status.engine.batteryChargeHV) {
      this.batteryChargeHV = status.engine.batteryChargeHV;
      this.log.info(`new battery charge is ${this.batteryChargeHV}`);
    }
    // Push every characteristic that can change, not just the low-battery
    // flag. Level and charging state were only ever recomputed on an explicit
    // read, so HomeKit kept showing whatever it last happened to fetch.
    this.service?.updateCharacteristic(
      this.Characteristic.BatteryLevel,
      this.rangePct,
    );
    this.service?.updateCharacteristic(
      this.Characteristic.ChargingState,
      this.chargingState,
    );
    this.service?.updateCharacteristic(
      this.Characteristic.StatusLowBattery,
      this.statusLowBattery,
    );
  }

  get rangePct(): number {
    return clampPercent(this.rawRangePct);
  }

  private get rawRangePct(): number {
    // Note the truthiness check on batteryChargeHV is deliberate: hybrids
    // report 0 here and want the range-based estimate instead.
    if (this.batteryChargeHV) {
      return this.batteryChargeHV;
    } else if (!this.maxRange) {
      return 100;
    } else if (!this.currentRange) {
      return 0;
    } else {
      return (this.currentRange / this.maxRange) * 100;
    }
  }
  get statusLowBattery(): number {
    const { StatusLowBattery } = this.Characteristic;
    if (this.rangePct < this.lowBatteryThreshold) {
      return StatusLowBattery.BATTERY_LEVEL_LOW;
    } else {
      return StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }
  }
}

// BatteryLevel is a whole percentage. A range ratio produces fractions, and
// range briefly exceeding the learned maximum would push it past 100, both of
// which the characteristic rejects.
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}
