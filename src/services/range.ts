import { HyundaiService } from './base';
import { VehicleStatus } from 'bluelinky/dist/interfaces/common.interfaces';

// HomeKit has no characteristic for distance, so estimated range cannot be
// published as miles. What it does have is relative humidity: a plain 0-100
// percentage that the Home app renders on its own tile, rather than hiding it
// on the accessory's settings page the way it does battery level.
//
// So this reports range as a percentage of the configured maximum - the same
// figure the battery service carries, but somewhere it can actually be seen
// and read by Shortcuts. It is off unless `showRangeSensor` is set, because a
// tile labelled as humidity is a surprising thing to hand someone who did not
// ask for it.
export class Range extends HyundaiService {
  private maxRange?: number;
  private currentRange?: number;
  name = 'Range';
  serviceType = 'HumiditySensor';

  initService(): void {
    this.maxRange = this.accessory.context.device.maxRange;

    this.service
      ?.getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
      .on('get', cb => cb(null, this.rangePct));
  }

  setCurrentState(status: VehicleStatus): void {
    this.currentRange = status.engine.range;

    // Track the best range seen, so an unset or conservative maxRange still
    // produces a sane percentage instead of pinning at 100.
    if (
      this.currentRange !== undefined &&
      (!this.maxRange || this.currentRange > this.maxRange)
    ) {
      this.maxRange = this.currentRange;
    }

    this.service?.updateCharacteristic(
      this.Characteristic.CurrentRelativeHumidity,
      this.rangePct,
    );
  }

  // Deliberately range-based only, unlike the battery service, which prefers
  // the HV charge when a vehicle reports one. This tile is about range.
  get rangePct(): number {
    if (!this.maxRange || !this.currentRange) {
      return 0;
    }
    const pct = (this.currentRange / this.maxRange) * 100;
    if (!Number.isFinite(pct)) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.round(pct)));
  }
}
